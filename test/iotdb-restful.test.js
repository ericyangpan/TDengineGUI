'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const IoTDBRestful = require('../renderer/js/iotdbRestful')

test('desktop client browses and pages data from live Tree and Table servers', { skip: !process.env.IOTDB_TEST_URL }, async () => {
    const endpoint = new URL(process.env.IOTDB_TEST_URL)
    for (const model of ['tree', 'table']) {
        const cn = { host: endpoint.hostname, port: endpoint.port, protocol: endpoint.protocol.slice(0, -1), model,
            user: process.env.IOTDB_TEST_USER, password: process.env.IOTDB_TEST_PASSWORD }
        const name = 'desktop_' + require('node:crypto').randomUUID().replace(/-/g, '')
        const db = model === 'tree' ? 'root.' + name : name
        const table = model === 'tree' ? db + '.meter' : 'meter'
        const check = result => { assert.equal(result.res, true, JSON.stringify(result)); return result }
        check(await IoTDBRestful.createDatabase(db, cn))
        try {
            check(await IoTDBRestful.rawSql(model === 'tree' ? `CREATE TIMESERIES ${table}.v WITH DATATYPE=INT32,ENCODING=RLE` : 'CREATE TABLE meter(v INT32 FIELD)', cn, db))
            check(await IoTDBRestful.rawSql(`INSERT INTO ${table}(time,v) VALUES(1735689600000,37),(1735689600001,38)`, cn, db))
            const tables = check(await IoTDBRestful.showTables(db, cn))
            assert.ok(tables.data.some(row => row.name === table), JSON.stringify(tables))
            const page = check(await IoTDBRestful.selectData(table, db, cn, ['v'], '', 1, 0, null))
            assert.equal(page.count, 2)
            assert.equal(page.data.length, 1)
            const key = model === 'tree' ? `${table}.v` : 'v'
            assert.ok([37, 38].includes(page.data[0][key]), JSON.stringify(page))
        } finally {
            check(await IoTDBRestful.dropDatabase(db, cn))
        }
    }
})

const treeConnection = {
    host: '127.0.0.1',
    port: '18080',
    user: 'test-user',
    password: 'test-password',
    timeout: 4000,
    model: 'tree'
}

function stubClient(response, inspect) {
    return IoTDBRestful.createClient({
        post: async (url, body, config) => {
            if (inspect) inspect(url, body, config)
            if (response instanceof Error) throw response
            return { data: response }
        }
    })
}

test('normalizes Tree query columns and timestamps into row objects', () => {
    const result = IoTDBRestful.normalizeTreeResponse({
        expressions: ['root.sg.device.temperature', 'root.sg.device.active'],
        column_names: null,
        timestamps: [100, 200],
        values: [[21.5, null], [true, false]]
    })

    assert.deepEqual(result, {
        res: true,
        count: 2,
        data: [
            { time: 100, 'root.sg.device.temperature': 21.5, 'root.sg.device.active': true },
            { time: 200, 'root.sg.device.temperature': null, 'root.sg.device.active': false }
        ]
    })
})

test('normalizes Tree metadata columns into rows', () => {
    const result = IoTDBRestful.normalizeTreeResponse({
        expressions: null,
        column_names: ['timeseries', 'dataType'],
        timestamps: null,
        values: [['root.sg.device.temperature', 'root.sg.device.active'], ['FLOAT', 'BOOLEAN']]
    })

    assert.deepEqual(result.data, [
        { timeseries: 'root.sg.device.temperature', dataType: 'FLOAT' },
        { timeseries: 'root.sg.device.active', dataType: 'BOOLEAN' }
    ])
})

test('normalizes Table row responses', () => {
    const result = IoTDBRestful.normalizeTableResponse({
        column_names: ['time', 'temperature'],
        data_types: ['TIMESTAMP', 'FLOAT'],
        values: [[100, 21.5], [200, 22.0]]
    })

    assert.deepEqual(result.data, [
        { time: 100, temperature: 21.5 },
        { time: 200, temperature: 22.0 }
    ])
})

test('sends Tree SQL with Basic auth, bounded timeout, and row limit', async () => {
    let request
    const client = stubClient({
        expressions: ['root.sg.device.temperature'],
        timestamps: [100],
        values: [[21.5]]
    }, (url, body, config) => { request = { url, body, config } })

    const result = await client.rawSql('SELECT temperature FROM root.sg.device', treeConnection)

    assert.equal(result.res, true)
    assert.equal(request.url, 'http://127.0.0.1:18080/rest/v2/query')
    assert.deepEqual(request.body, { sql: 'SELECT temperature FROM root.sg.device', row_limit: 10000 })
    assert.deepEqual(request.config.auth, { username: 'test-user', password: 'test-password' })
    assert.equal(request.config.timeout, 4000)
})

test('sends Table SQL with selected database and Table REST route', async () => {
    let request
    const client = stubClient({ column_names: ['TableName'], values: [['sensor_data']] },
        (url, body, config) => { request = { url, body, config } })

    const result = await client.rawSql('SHOW TABLES', { ...treeConnection, model: 'table' }, 'telemetry')

    assert.equal(result.res, true)
    assert.equal(request.url, 'http://127.0.0.1:18080/rest/table/v1/query')
    assert.deepEqual(request.body, { sql: 'SHOW TABLES', database: 'telemetry', row_limit: 10000 })
})

test('uses nonQuery endpoint for Tree DDL and prefixes a database name', async () => {
    let request
    const client = stubClient({ code: 200, message: 'SUCCESS_STATUS' },
        (url, body) => { request = { url, body } })

    const result = await client.createDatabase('telemetry', treeConnection)

    assert.equal(result.res, true)
    assert.equal(request.url, 'http://127.0.0.1:18080/rest/v2/nonQuery')
    assert.deepEqual(request.body, { sql: 'CREATE DATABASE root.telemetry' })
})

test('groups Tree timeseries metadata into device paths', async () => {
    const client = stubClient({
        expressions: null,
        column_names: ['timeseries', 'dataType'],
        values: [['root.sg.line.device.temperature', 'root.sg.line.device.pressure'], ['FLOAT', 'FLOAT']]
    })

    const result = await client.showTables('root.sg', treeConnection)

    assert.deepEqual(result.data.map(row => row.device_path), ['root.sg.line.device'])
})

test('queries Tree devices with time bounds, bounded pagination, and selected columns', async () => {
    let query
    const client = stubClient({
        expressions: ['root.sg.device.temperature', 'root.sg.device.pressure'],
        timestamps: [100, 200, 300],
        values: [[21.5, 22.0, 23.0], [100, 101, 102]]
    }, (url, body) => { query = body.sql })

    const result = await client.selectData('root.sg.device', 'root.sg', treeConnection,
        ['time', 'root.sg.device.temperature'], '', 2, 4, null, '1970-01-01T00:00:00.050Z', null)

    assert.match(query, /FROM root\.sg\.device WHERE time >= 50 LIMIT 3 OFFSET 4/)
    assert.deepEqual(result.data, [
        { time: 100, 'root.sg.device.temperature': 21.5 },
        { time: 200, 'root.sg.device.temperature': 22.0 }
    ])
    assert.equal(result.count, 7)
})

test('queries Table rows with selected database and exact count', async () => {
    const requests = []
    const client = IoTDBRestful.createClient({
        post: async (url, body, config) => {
            requests.push({ url, body, config })
            if (body.sql.startsWith('SELECT COUNT')) {
                return { data: { column_names: ['row_count'], values: [[35]] } }
            }
            return { data: { column_names: ['time', 'temperature'], values: [[100, 21.5]] } }
        }
    })

    const result = await client.selectData('sensor_data', 'telemetry', { ...treeConnection, model: 'table' },
        ['time', 'temperature'], '', 20, 0, null)

    assert.equal(requests.length, 2)
    assert.equal(requests[0].body.database, 'telemetry')
    assert.match(requests[0].body.sql, /SELECT time, temperature FROM sensor_data LIMIT 20 OFFSET 0/)
    assert.equal(result.count, 35)
})

test('returns server authentication errors without hiding the response message', async () => {
    const error = new Error('Request failed')
    error.response = { status: 600, data: { code: 600, message: 'WRONG_LOGIN_PASSWORD_ERROR' } }
    const result = await stubClient(error).rawSql('SHOW DATABASES', treeConnection)

    assert.equal(result.res, false)
    assert.equal(result.code, 600)
    assert.equal(result.msg, 'WRONG_LOGIN_PASSWORD_ERROR')
})

test('returns a distinct timeout error', async () => {
    const error = new Error('timeout of 4000ms exceeded')
    error.code = 'ECONNABORTED'
    const result = await stubClient(error).rawSql('SHOW DATABASES', treeConnection)

    assert.equal(result.res, false)
    assert.equal(result.code, 'TIMEOUT')
    assert.match(result.msg, /timed out/i)
})

test('rejects unsafe host and SQL identifiers', async () => {
    const hostResult = await stubClient({}).rawSql('SHOW DATABASES', { ...treeConnection, host: 'db.example/path' })
    const pathResult = await stubClient({}).showTables('root.sg;DROP', treeConnection)
    const identifierResult = await stubClient({}).dropTable('sensor; DROP DATABASE x', 'telemetry', { ...treeConnection, model: 'table' })

    assert.equal(hostResult.res, false)
    assert.equal(pathResult.res, false)
    assert.equal(identifierResult.res, false)
})
