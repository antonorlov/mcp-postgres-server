#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
const { Client } = pg;
import { Client as SshClient, type ConnectConfig, type ClientChannel } from 'ssh2';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';

// Load environment variables
config();

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface SshTunnelConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  hostFingerprint?: string;
}

// Type guard for error objects
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

// Helper to get error message
function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Helper to convert ? parameters to $1, $2, etc.
function convertToNamedParams(query: string): string {
  let paramIndex = 0;
  return query.replace(/\?/g, () => `$${++paramIndex}`);
}

class PostgresServer {
  private server: Server;
  private client: pg.Client | null = null;
  private config: DatabaseConfig | null = null;
  private sshClient: SshClient | null = null;
  private sshConfig: SshTunnelConfig | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'postgres-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    const handleTermination = async () => {
      try {
        await this.cleanup();
      } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
      }
      process.exit(0);
    };
    process.on('SIGINT', handleTermination);
    process.stdin.on('close', handleTermination);
  }

  private async cleanup() {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }
    await this.server.close();
  }

  private async ensureConnection() {
    if (!this.config) {
      // Try to use environment variables if no explicit config was provided
      const envConfig = this.getEnvConfig();
      
      if (envConfig) {
        this.config = envConfig;
        this.sshConfig = this.getSshConfig();
        console.error('[MCP Info] Using database config from environment variables');
      } else {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'Database configuration not set. Use connect_db tool first or set environment variables.'
        );
      }
    }

    if (!this.client) {
      try {
        const stream = this.sshConfig
          ? await this.createSshStream(this.config.host, this.config.port)
          : undefined;
        this.client = new Client({ ...this.config, ...(stream ? { stream: () => stream } : {}) });
        await this.client.connect();
      } catch (error) {
        if (this.sshClient) {
          this.sshClient.end();
          this.sshClient = null;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${getErrorMessage(error)}`
        );
      }
    }
  }
  
  private getEnvConfig(): DatabaseConfig | null {
    const { PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE, PG_PORT } = process.env;
    
    if (PG_HOST && PG_USER && PG_PASSWORD && PG_DATABASE) {
      return {
        host: PG_HOST,
        port: PG_PORT ? parseInt(PG_PORT, 10) : 5432,
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE
      };
    }
    
    return null;
  }

  private getSshConfig(): SshTunnelConfig | null {
    const {
      SSH_HOST,
      SSH_PORT,
      SSH_USER,
      SSH_PASSWORD,
      SSH_PRIVATE_KEY,
      SSH_PRIVATE_KEY_PATH,
      SSH_PRIVATE_KEY_PASSPHRASE,
      SSH_HOST_FINGERPRINT,
    } = process.env;

    const hasSshConfiguration = [
      SSH_HOST,
      SSH_PORT,
      SSH_USER,
      SSH_PASSWORD,
      SSH_PRIVATE_KEY,
      SSH_PRIVATE_KEY_PATH,
      SSH_PRIVATE_KEY_PASSPHRASE,
      SSH_HOST_FINGERPRINT,
    ].some(Boolean);
    if (!hasSshConfiguration) {
      return null;
    }

    if (!SSH_HOST || !SSH_USER) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'SSH tunnel configuration requires both SSH_HOST and SSH_USER'
      );
    }

    const port = SSH_PORT ? parseInt(SSH_PORT, 10) : 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new McpError(ErrorCode.InvalidRequest, 'SSH_PORT must be a valid TCP port');
    }

    const privateKey = SSH_PRIVATE_KEY || (SSH_PRIVATE_KEY_PATH ? readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8') : undefined);
    if (!SSH_PASSWORD && !privateKey) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'SSH tunnel configuration requires SSH_PASSWORD, SSH_PRIVATE_KEY, or SSH_PRIVATE_KEY_PATH'
      );
    }

    return {
      host: SSH_HOST,
      port,
      username: SSH_USER,
      password: SSH_PASSWORD,
      privateKey,
      passphrase: SSH_PRIVATE_KEY_PASSPHRASE,
      hostFingerprint: SSH_HOST_FINGERPRINT,
    };
  }

  private async createSshStream(destinationHost: string, destinationPort: number): Promise<ClientChannel> {
    if (!this.sshConfig) {
      throw new Error('SSH tunnel configuration is not set');
    }

    const { host, port, username, password, privateKey, passphrase, hostFingerprint } = this.sshConfig;
    const sshOptions: ConnectConfig = { host, port, username, password, privateKey, passphrase };
    if (hostFingerprint) {
      sshOptions.hostHash = 'sha256';
      sshOptions.hostVerifier = (hash: string) => hash === hostFingerprint.replace(/^SHA256:/, '');
    } else {
      console.error('[MCP Warning] SSH_HOST_FINGERPRINT is not set; the SSH host key will not be verified');
    }

    this.sshClient = new SshClient();
    await new Promise<void>((resolve, reject) => {
      this.sshClient!.once('ready', resolve);
      this.sshClient!.once('error', reject);
      this.sshClient!.connect(sshOptions);
    });

    return new Promise<ClientChannel>((resolve, reject) => {
      this.sshClient!.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'connect_db',
          description: 'Connect to PostgreSQL database. NOTE: Default connection exists - only use when requested or if other commands fail',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Database host',
              },
              port: {
                type: 'number',
                description: 'Database port (default: 5432)',
              },
              user: {
                type: 'string',
                description: 'Database user',
              },
              password: {
                type: 'string',
                description: 'Database password',
              },
              database: {
                type: 'string',
                description: 'Database name',
              },
            },
            required: ['host', 'user', 'password', 'database'],
          },
        },
        {
          name: 'query',
          description: 'Execute a SELECT query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL SELECT query (use $1, $2, etc. for parameters)',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'execute',
          description: 'Execute an INSERT, UPDATE, or DELETE query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL query (INSERT, UPDATE, DELETE) (use $1, $2, etc. for parameters)',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'list_schemas',
          description: 'List all schemas in the database',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_tables',
          description: 'List tables in the database',
          inputSchema: {
            type: 'object',
            properties: {
              schema: {
                type: 'string',
                description: 'Schema name (default: public)',
              },
            },
            required: [],
          },
        },
        {
          name: 'describe_table',
          description: 'Get table structure',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
              schema: {
                type: 'string',
                description: 'Schema name (default: public)',
              },
            },
            required: ['table'],
          },
        },
      ],
    }));
  
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'connect_db':
          return await this.handleConnectDb(request.params.arguments);
        case 'query':
          return await this.handleQuery(request.params.arguments);
        case 'execute':
          return await this.handleExecute(request.params.arguments);
        case 'list_schemas':
          return await this.handleListSchemas();
        case 'list_tables':
          return await this.handleListTables(request.params.arguments);
        case 'describe_table':
          return await this.handleDescribeTable(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleConnectDb(args: any) {
    if (!args.host || !args.user || !args.password || !args.database) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Missing required database configuration parameters'
      );
    }

    // Close existing connection and SSH tunnel if any
    if (this.client || this.sshClient) {
      if (this.client) {
        await this.client.end();
        this.client = null;
      }
      if (this.sshClient) {
        this.sshClient.end();
        this.sshClient = null;
      }
    }

    this.config = {
      host: args.host,
      port: args.port || 5432,
      user: args.user,
      password: args.password,
      database: args.database,
    };
    this.sshConfig = this.getSshConfig();

    try {
      await this.ensureConnection();
      return {
        content: [
          {
            type: 'text',
            text: 'Successfully connected to PostgreSQL database',
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect to database: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleQuery(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    if (!args.sql.trim().toUpperCase().startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only SELECT queries are allowed with query tool'
      );
    }

    try {
      // Convert ? parameters to $1, $2, etc. if needed
      const sql = args.sql.includes('?') ? convertToNamedParams(args.sql) : args.sql;
      const result = await this.client!.query(sql, args.params || []);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleExecute(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    const sql = args.sql.trim().toUpperCase();
    if (sql.startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Use query tool for SELECT statements'
      );
    }

    try {
      // Convert ? parameters to $1, $2, etc. if needed
      const preparedSql = args.sql.includes('?') ? convertToNamedParams(args.sql) : args.sql;
      const result = await this.client!.query(preparedSql, args.params || []);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rowCount: result.rowCount,
              command: result.command,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleListSchemas() {
    await this.ensureConnection();
  
    try {
      const result = await this.client!.query(`
        SELECT schema_name
        FROM information_schema.schemata
        ORDER BY schema_name
      `);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list schemas: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleListTables(args: any = {}) {
    await this.ensureConnection();
  
    const schema = args.schema || 'public';
  
    try {
      const result = await this.client!.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name
      `, [schema]);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tables: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleDescribeTable(args: any) {
    await this.ensureConnection();
  
    if (!args.table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }
  
    const schema = args.schema || 'public';
  
    try {
      const result = await this.client!.query(`
        SELECT 
          c.column_name, 
          c.data_type, 
          c.is_nullable, 
          c.column_default,
          CASE 
            WHEN pk.constraint_type = 'PRIMARY KEY' THEN true 
            ELSE false 
          END AS is_primary_key,
          c.character_maximum_length
        FROM 
          information_schema.columns c
        LEFT JOIN (
          SELECT 
            tc.constraint_type, 
            kcu.column_name, 
            kcu.table_name,
            kcu.table_schema
          FROM 
            information_schema.table_constraints tc
          JOIN 
            information_schema.key_column_usage kcu
          ON 
            tc.constraint_name = kcu.constraint_name
          WHERE 
            tc.constraint_type = 'PRIMARY KEY'
        ) pk
        ON 
          c.column_name = pk.column_name
          AND c.table_name = pk.table_name
          AND c.table_schema = pk.table_schema
        WHERE 
          c.table_schema = $1 
          AND c.table_name = $2
        ORDER BY 
          c.ordinal_position
      `, [schema, args.table]);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to describe table: ${getErrorMessage(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PostgreSQL MCP server running on stdio');
  }
}

const server = new PostgresServer();
server.run().catch(console.error);
