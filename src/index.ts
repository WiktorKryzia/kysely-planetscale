import {Client, Config, Connection, Field, cast} from '@planetscale/database'
import {parseJSON} from 'date-fns'
import {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  QueryCompiler,
  QueryResult,
} from 'kysely'

/**
 * Config for the PlanetScale dialect. It extends {@link Config} from `@planetscale/database`,
 * so you can pass any of those options to the constructor.
 *
 * @see https://github.com/planetscale/database-js#usage
 */
export interface PlanetScaleDialectConfig extends Config {
  /**
   * Use a single `@planetscale/database` connection for all non-transaction queries.
   *
   * @default false
   */
  useSharedConnection?: boolean
}

/**
 * PlanetScale dialect that uses the [PlanetScale Serverless Driver for JavaScript][0].
 * The constructor takes an instance of {@link Config} from `@planetscale/database`.
 *
 * ```typescript
 * new PlanetScaleDialect({
 *   host: '<host>',
 *   username: '<username>',
 *   password: '<password>',
 * })
 *
 * // or with a connection URL
 *
 * new PlanetScaleDialect({
 *   url: process.env.DATABASE_URL ?? 'mysql://<username>:<password>@<host>/<database>'
 * })
 * ```
 *
 * See the [`@planetscale/database` documentation][1] for more information.
 *
 * [0]: https://github.com/planetscale/database-js
 * [1]: https://github.com/planetscale/database-js#readme
 */
export class PlanetScaleDialect implements Dialect {
  #config: PlanetScaleDialectConfig

  constructor(config: PlanetScaleDialectConfig) {
    this.#config = config
  }

  createAdapter() {
    return new MysqlAdapter()
  }

  createDriver(): Driver {
    return new PlanetScaleDriver(this.#config)
  }

  createQueryCompiler(): QueryCompiler {
    return new MysqlQueryCompiler()
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new MysqlIntrospector(db)
  }
}

class PlanetScaleDriver implements Driver {
  #config: PlanetScaleDialectConfig

  constructor(config: PlanetScaleDialectConfig) {
    this.#config = config
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PlanetScaleConnection(this.#config)
  }

  async beginTransaction(conn: PlanetScaleConnection): Promise<void> {
    return await conn.beginTransaction()
  }

  async commitTransaction(conn: PlanetScaleConnection): Promise<void> {
    return await conn.commitTransaction()
  }

  async rollbackTransaction(conn: PlanetScaleConnection): Promise<void> {
    return await conn.rollbackTransaction()
  }

  async releaseConnection(_conn: PlanetScaleConnection): Promise<void> {}

  async destroy(): Promise<void> {}
}

const sharedConnections = new WeakMap<PlanetScaleDialectConfig, Connection>()

class PlanetScaleConnection implements DatabaseConnection {
  #config: PlanetScaleDialectConfig
  #client: Client
  #transactionClient?: PlanetScaleConnection

  get #conn(): Connection {
    if (this.#transactionClient) return this.#transactionClient.#conn
    if (this.#useSharedConnection) return sharedConnections.get(this.#config) as Connection
    return this.#client.connection()
  }

  get #useSharedConnection(): boolean {
    return Boolean(this.#config.useSharedConnection && !this.#transactionClient)
  }

  constructor(config: PlanetScaleDialectConfig, isForTransaction = false) {
    this.#config = config
    const useSharedConnection = config.useSharedConnection && !isForTransaction
    this.#client = new Client({cast: inflateDates, ...config})
    if (useSharedConnection) sharedConnections.set(config, this.#client.connection())
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    if (this.#transactionClient) return this.#transactionClient.executeQuery(compiledQuery)

    // If no custom formatter is provided, format dates as DB date strings
    const parameters = this.#config.format
      ? compiledQuery.parameters
      : compiledQuery.parameters.map((param) => (param instanceof Date ? formatDate(param) : param))

    const results = await this.#conn.execute(compiledQuery.sql, parameters)

    // @planetscale/database versions older than 1.3.0 return errors directly, rather than throwing
    if ((results as any).error) {
      throw (results as any).error
    }

    const numAffectedRows = results.rowsAffected == null ? undefined : BigInt(results.rowsAffected)

    return {
      insertId: results.insertId !== null && results.insertId.toString() !== '0' ? BigInt(results.insertId) : undefined,
      rows: results.rows as O[],
      // @ts-ignore replaces `QueryResult.numUpdatedOrDeletedRows` in kysely > 0.22
      // following https://github.com/koskimas/kysely/pull/188
      numAffectedRows,
      // deprecated in kysely > 0.22, keep for backward compatibility.
      numUpdatedOrDeletedRows: numAffectedRows,
    }
  }

  async beginTransaction() {
    this.#transactionClient = this.#transactionClient ?? new PlanetScaleConnection(this.#config, true)
    await this.#transactionClient.#conn.execute('BEGIN')
  }

  async commitTransaction() {
    if (!this.#transactionClient) throw new Error('No transaction to commit')
    try {
      await this.#transactionClient.#conn.execute('COMMIT')
    } finally {
      this.#transactionClient = undefined
    }
  }

  async rollbackTransaction() {
    if (!this.#transactionClient) throw new Error('No transaction to rollback')
    try {
      await this.#transactionClient.#conn.execute('ROLLBACK')
    } finally {
      this.#transactionClient = undefined
    }
  }

  async *streamQuery<O>(_compiledQuery: CompiledQuery, _chunkSize: number): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('PlanetScale Serverless Driver does not support streaming')
  }
}

/**
 * Converts dates returned from the database to JavaScript Date objects. This is the default
 * `cast` function passed to the `@planetscale/database` library, but you can override it by
 * passing your own alternative `cast` function to {@link Config}.
 */
export function inflateDates(field: Field, value: string | null) {
  if (field.type === 'DATETIME' && value) return parseJSON(value)
  if (field.type === 'TIMESTAMP' && value) return parseJSON(value)
  return cast(field, value)
}

function formatDate(date: Date): string {
  return date.toISOString().replace(/[TZ]/g, ' ').trim()
}
