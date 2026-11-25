'use strict'

const DEFAULT_TIMEOUT_MS = 10000
const MAX_QUERY_ROWS = 10000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

function safeHost(hostValue) {
    const input = String(hostValue || '').trim()
    if (!input || /[\/?#@]/.test(input) || input.includes('://')) {
        throw new Error('Host must be a hostname or IP address without a URL path')
    }
    if (input.startsWith('[') && input.endsWith(']')) return input
    return input.includes(':') ? `[${input}]` : input
}

function endpoint(payload, path) {
    const protocol = payload.protocol === 'https' ? 'https' : 'http'
    const host = safeHost(payload.host || payload.ip)
    const port = Number(payload.port || 18080)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Port must be an integer between 1 and 65535')
    }
    return `${protocol}://${host}:${port}${path}`
}

function normalizeTreeResponse(body) {
    if (!body || typeof body !== 'object') {
        throw new Error('IoTDB returned an invalid response')
    }
    if (body.code !== undefined && Number(body.code) !== 200) {
        return { res: false, msg: body.message || `IoTDB error ${body.code}`, code: body.code }
    }

    const rows = []
    const expressions = Array.isArray(body.expressions) ? body.expressions : []
    const names = Array.isArray(body.column_names) ? body.column_names : []
    const values = Array.isArray(body.values) ? body.values : []

    if (expressions.length) {
        const timestamps = Array.isArray(body.timestamps) ? body.timestamps : []
        for (let rowIndex = 0; rowIndex < timestamps.length; rowIndex += 1) {
            const row = { time: timestamps[rowIndex] }
            expressions.forEach((expression, columnIndex) => {
                row[expression] = Array.isArray(values[columnIndex]) ? values[columnIndex][rowIndex] : null
            })
            rows.push(row)
        }
    } else if (names.length) {
        const rowCount = values.reduce((count, column) => Math.max(count, Array.isArray(column) ? column.length : 0), 0)
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
            const row = {}
            names.forEach((name, columnIndex) => {
                row[name] = Array.isArray(values[columnIndex]) ? values[columnIndex][rowIndex] : null
            })
            rows.push(row)
        }
    }

    return { res: true, count: rows.length, data: rows }
}

function normalizeTableResponse(body) {
    if (!body || typeof body !== 'object') {
        throw new Error('IoTDB returned an invalid response')
    }
    if (body.code !== undefined && Number(body.code) !== 200) {
        return { res: false, msg: body.message || `IoTDB error ${body.code}`, code: body.code }
    }
    const names = Array.isArray(body.column_names) ? body.column_names : []
    const values = Array.isArray(body.values) ? body.values : []
    const rows = values.map(valuesRow => {
        const row = {}
        names.forEach((name, index) => {
            row[name] = Array.isArray(valuesRow) ? valuesRow[index] : undefined
        })
        return row
    })
    return { res: true, count: rows.length, data: rows }
}

function isQueryStatement(sql) {
    return /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|LIST|COUNT)\b/i.test(sql)
}

function safeTreePath(pathValue) {
    const path = String(pathValue || '').trim()
    const segments = path.split('.')
    if (segments.length < 2 || segments[0] !== 'root' ||
        segments.some(segment => segment !== '**' && segment !== '*' && !/^[A-Za-z0-9_-]+$/.test(segment))) {
        throw new Error('IoTDB Tree paths must use simple root-qualified identifiers')
    }
    return path
}

function safeTableIdentifier(identifier) {
    const value = String(identifier || '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error('IoTDB Table identifiers must use letters, numbers, and underscores')
    }
    return value
}

function databasePath(database) {
    const value = String(database || '').trim()
    return value.startsWith('root.') ? safeTreePath(value) : safeTreePath(`root.${value}`)
}

function sqlTime(value, model, operator) {
    if (!value) return ''
    if (model === 'tree') {
        const timestamp = new Date(value).getTime()
        if (!Number.isFinite(timestamp)) throw new Error('Invalid time filter')
        return `time ${operator} ${timestamp}`
    }
    const escaped = String(value).replace(/'/g, "''")
    return `time ${operator} '${escaped}'`
}

function buildWhere(where, startTime, endTime, model) {
    const clauses = []
    if (where) clauses.push(`(${where})`)
    const startClause = sqlTime(startTime, model, '>=')
    const endClause = sqlTime(endTime, model, '<=')
    if (startClause) clauses.push(startClause)
    if (endClause) clauses.push(endClause)
    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
}

function firstValue(row) {
    if (!row) return undefined
    const values = Object.values(row)
    return values.length ? values[0] : undefined
}

function valueFor(row, names) {
    for (const name of names) {
        if (row[name] !== undefined) return row[name]
    }
    return firstValue(row)
}

function normalizeDatabaseRows(result) {
    if (!result.res) return result
    return {
        ...result,
        data: result.data.map(row => ({ ...row, name: valueFor(row, ['name', 'database', 'Database', 'database_name']) }))
    }
}

function toUserMessage(error) {
    const body = error && error.response && error.response.data
    if (body && typeof body === 'object' && (body.message || body.desc)) {
        return { res: false, msg: body.message || body.desc, code: body.code || error.response.status }
    }
    if (error && (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || ''))) {
        return { res: false, msg: 'IoTDB request timed out; check the timeout and server load', code: 'TIMEOUT' }
    }
    if (error && error.response) {
        return { res: false, msg: `IoTDB HTTP ${error.response.status}`, code: error.response.status }
    }
    return { res: false, msg: `IoTDB connection failed: ${error && error.message ? error.message : 'network error'}`, code: -1 }
}

class IoTDBRestful {
    constructor(httpClient = null) {
        this.httpClient = httpClient
    }

    getHttpClient() {
        return this.httpClient || require('axios')
    }

    model(payload) {
        return payload && payload.model === 'table' ? 'table' : 'tree'
    }

    async sendRequest(sql, payload, database = null, forceNonQuery = false) {
        try {
            if (!payload || !payload.user || payload.password === undefined) {
                throw new Error('IoTDB username and password are required')
            }
            const model = this.model(payload)
            const query = !forceNonQuery && isQueryStatement(sql)
            const path = model === 'tree'
                ? (query ? '/rest/v2/query' : '/rest/v2/nonQuery')
                : (query ? '/rest/table/v1/query' : '/rest/table/v1/nonQuery')
            const body = model === 'tree'
                ? { sql }
                : { sql, database: database || payload.database || '' }
            if (query) body.row_limit = Math.max(1, Math.min(Number(payload.rowLimit) || MAX_QUERY_ROWS, MAX_QUERY_ROWS))

            const response = await this.getHttpClient().post(endpoint(payload, path), body, {
                auth: { username: payload.user, password: payload.password },
                timeout: Math.max(100, Math.min(Number(payload.timeout) || DEFAULT_TIMEOUT_MS, 120000)),
                maxContentLength: MAX_RESPONSE_BYTES,
                maxBodyLength: 1024 * 1024
            })
            return model === 'tree'
                ? normalizeTreeResponse(response.data)
                : normalizeTableResponse(response.data)
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async testConnect(payload) {
        const result = await this.showDatabases(payload)
        return result.res
    }

    async getVersion(payload) {
        const result = await this.showDatabases(payload)
        if (!result.res) return result.msg
        return `IoTDB 2.x (${this.model(payload)})`
    }

    async showDatabases(payload) {
        return normalizeDatabaseRows(await this.sendRequest('SHOW DATABASES', payload, ''))
    }

    async createDatabase(name, payload) {
        try {
            const database = this.model(payload) === 'tree'
                ? databasePath(name)
                : safeTableIdentifier(name)
            return this.sendRequest(`CREATE DATABASE ${database}`, payload, '', true)
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async dropDatabase(name, payload) {
        try {
            const database = this.model(payload) === 'tree'
                ? safeTreePath(name)
                : safeTableIdentifier(name)
            return this.sendRequest(`DROP DATABASE ${database}`, payload, '', true)
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async showTables(database, payload, like = null) {
        try {
            if (this.model(payload) === 'table') {
                const result = await this.sendRequest('SHOW TABLES', payload, database)
                if (!result.res) return result
                const data = result.data.map(row => {
                    const name = valueFor(row, ['table_name', 'TableName', 'name', 'table'])
                    return { ...row, table_name: name, name }
                })
                return { ...result, data: like ? data.filter(item => String(item.name).toLowerCase().includes(String(like).toLowerCase())) : data }
            }

            const path = `${databasePath(database)}.**`
            const metadata = await this.sendRequest(`SHOW TIMESERIES ${path}`, payload, database)
            if (!metadata.res) return metadata
            const devices = new Set()
            metadata.data.forEach(row => {
                const series = valueFor(row, ['timeseries', 'Timeseries', 'timeseries_name'])
                if (typeof series !== 'string') return
                const lastSeparator = series.lastIndexOf('.')
                if (lastSeparator > 4) devices.add(series.slice(0, lastSeparator))
            })
            const data = Array.from(devices).sort().map(device => ({ table_name: device, name: device, device_path: device }))
            const filtered = like ? data.filter(item => item.name.toLowerCase().includes(String(like).toLowerCase())) : data
            return { res: true, count: filtered.length, data: filtered }
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async showSuperTables() {
        return { res: true, count: 0, data: [] }
    }

    async describeMetadata(name, database, payload) {
        try {
            if (this.model(payload) === 'table') {
                const table = safeTableIdentifier(name)
                return this.sendRequest(`DESCRIBE ${table}`, payload, database)
            }
            const device = safeTreePath(name)
            return this.sendRequest(`SHOW TIMESERIES ${device}.**`, payload, database)
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async dropTable(name, database, payload) {
        try {
            const table = safeTableIdentifier(name)
            return this.sendRequest(`DROP TABLE IF EXISTS ${table}`, payload, database, true)
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async selectData(name, database, payload, fields = null, where = '', limit = 20, offset = 0, desc = null, startTime = null, endTime = null) {
        try {
            const model = this.model(payload)
            const pageSize = Math.max(1, Math.min(Number(limit) || 20, 1000))
            const pageOffset = Math.max(0, Number(offset) || 0)
            const filter = buildWhere(where, startTime, endTime, model)
            let query
            if (model === 'tree') {
                const device = safeTreePath(name)
                query = `SELECT * FROM ${device}${filter}`
                if (desc === 'DESC') query += ' ORDER BY TIME DESC'
            } else {
                const table = safeTableIdentifier(name)
                const projections = Array.isArray(fields) && fields.length
                    ? fields.map(field => field === 'time' ? 'time' : safeTableIdentifier(field)).join(', ')
                    : '*'
                query = `SELECT ${projections} FROM ${table}${filter}`
                if (desc === 'DESC') query += ' ORDER BY time DESC'
            }
            query += ` LIMIT ${pageSize + (model === 'tree' ? 1 : 0)} OFFSET ${pageOffset}`
            const result = await this.sendRequest(query, { ...payload, rowLimit: pageSize + 1 }, database)
            if (!result.res) return result

            if (model === 'tree') {
                const hasMore = result.data.length > pageSize
                result.data = result.data.slice(0, pageSize)
                if (Array.isArray(fields) && fields.length) {
                    const selected = new Set(fields)
                    result.data = result.data.map(row => Object.fromEntries(
                        Object.entries(row).filter(([column]) => selected.has(column) ||
                            Array.from(selected).some(field => column.endsWith(`.${field}`)))
                    ))
                }
                result.count = pageOffset + result.data.length + (hasMore ? 1 : 0)
            } else {
                const count = await this.sendRequest(`SELECT COUNT(*) AS row_count FROM ${safeTableIdentifier(name)}${filter}`, payload, database)
                result.count = count.res && count.data.length ? Number(valueFor(count.data[0], ['row_count', 'count(*)', 'count'])) || 0 : result.data.length
            }
            return result
        } catch (error) {
            return toUserMessage(error)
        }
    }

    async rawSql(sql, payload, database = null) {
        return this.sendRequest(sql, payload, database)
    }
}

const client = new IoTDBRestful()
client.createClient = httpClient => new IoTDBRestful(httpClient)
client.normalizeTreeResponse = normalizeTreeResponse
client.normalizeTableResponse = normalizeTableResponse
client.endpoint = endpoint
module.exports = client
