# Apache IoTDB 2.x Support

The desktop client supports Apache IoTDB through its documented REST services. Select the server model when creating a connection; Tree and Table use different request routes, SQL contexts, and response layouts.

## Server setup

IoTDB REST is disabled by default. Set `enable_rest_service=true` in `conf/iotdb-system.properties` and restart the DataNode. The default REST port is `18080`; the connection form accepts HTTP or HTTPS, username, password, and a request timeout from 1 to 120 seconds. HTTPS certificate validation remains enabled.

Authentication uses HTTP Basic Auth. The application sends credentials in the Authorization header and does not place them in URLs or SQL. Connection records, including passwords, are stored locally by the existing Electron Store setup, which does not encrypt values at rest.

## Model behavior

| Model | Query endpoint | Request shape | Browser |
| --- | --- | --- | --- |
| Tree | `/rest/v2/query` and `/rest/v2/nonQuery` | `{ "sql": "...", "row_limit": 10000 }` | Lists device paths derived from `SHOW TIMESERIES <database>.**`; selecting a device runs a bounded query from that path. |
| Table | `/rest/table/v1/query` and `/rest/table/v1/nonQuery` | `{ "database": "...", "sql": "...", "row_limit": 10000 }` | Lists tables with `SHOW TABLES`; selecting a table queries rows and a total count. |

The Tree REST response is column-oriented and includes a separate timestamp array. The Table response is row-oriented and returns column names. The adapter normalizes both into rows for the existing result grid. Time filters are sent as epoch milliseconds for Tree and timestamp strings for Table.

The connection view offers database create/drop, the model-appropriate metadata browser, a SQL console, date filtering, selected columns, and bounded pages. The Tree device browser groups timeseries by their parent path and does not display devices without timeseries. Device deletion is intentionally not exposed as a table drop operation. Table mode supports dropping a selected table.

## Limits

- IoTDB limits query responses to 10,000 rows by default. The client requests only the current page for data queries; metadata listings larger than the configured REST limit return the server error for display.
- Tree pagination uses a one-row lookahead because there is no single count of rows across a multi-measurement device query. The displayed total indicates whether another page exists and may grow as pages are opened.
- The UI displays the configured model and the label `IoTDB 2.x`; it does not claim to have discovered the exact server patch version.
- Compatibility is implemented against the current Apache IoTDB REST documentation. This checkout has not been tested against a live IoTDB server, so version-specific SQL behavior should be verified against the target cluster.
