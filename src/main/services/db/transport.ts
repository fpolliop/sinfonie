/** Transports shared by the SQL drivers: SSH tunnel (stream or local port) and the Cloud SQL connector over gcloud tokens. */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createServer, type Server, type Socket } from 'net'
import { Client as SshClient } from 'ssh2'
import { Connector, IpAddressTypes, AuthTypes } from '@google-cloud/cloud-sql-connector'
import { OAuth2Client } from 'google-auth-library'
import * as gcp from '../gcp'
import type { DbConnection, DbSecrets } from '@shared/types'

const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/** Google auth client that mints tokens with the local gcloud login of a given account. */
export class GcloudAuth extends OAuth2Client {
  constructor(private readonly account?: string) {
    super()
  }
  private async token(): Promise<string> {
    return gcp.accessToken(this.account)
  }
  override async getAccessToken(): Promise<{ token?: string | null; res?: null }> {
    return { token: await this.token(), res: null }
  }
  override async getRequestHeaders(): Promise<Headers> {
    return new Headers({ Authorization: `Bearer ${await this.token()}` })
  }
  protected override async getRequestMetadataAsync(): Promise<{ headers: Headers; res?: null }> {
    return { headers: await this.getRequestHeaders(), res: null }
  }
}

export async function sshClient(conn: DbConnection, secrets: DbSecrets): Promise<SshClient> {
  const t = conn.tunnel!
  if (!t.sshHost) throw new Error('SSH tunnel without a host.')
  const ssh = new SshClient()
  await new Promise<void>((resolve, reject) => {
    ssh
      .on('ready', () => resolve())
      .on('error', reject)
      .connect({
        host: t.sshHost,
        port: t.sshPort || 22,
        username: t.sshUser || process.env.USER,
        ...(t.sshKeyPath ? { privateKey: readFileSync(expandHome(t.sshKeyPath)) } : {}),
        ...(secrets.sshPassphrase ? { passphrase: secrets.sshPassphrase } : {}),
        ...(secrets.sshPassword ? { password: secrets.sshPassword } : {}),
        readyTimeout: 20_000
      })
  })
  return ssh
}

/** One forwarded stream to the database host, for drivers that accept a socket (pg, mysql2). */
export async function sshStream(conn: DbConnection, secrets: DbSecrets, defaultPort: number): Promise<{ stream: import('stream').Duplex; cleanup: () => void }> {
  const ssh = await sshClient(conn, secrets)
  const stream = await new Promise<import('stream').Duplex>((resolve, reject) => ssh.forwardOut('127.0.0.1', 0, conn.host || '127.0.0.1', conn.port || defaultPort, (err, s) => (err ? reject(err) : resolve(s))))
  return { stream, cleanup: () => ssh.end() }
}

/** A local TCP port that forwards every connection through SSH, for drivers that only take host:port (mongodb). */
export async function sshLocalPort(conn: DbConnection, secrets: DbSecrets, defaultPort: number): Promise<{ port: number; cleanup: () => void }> {
  const ssh = await sshClient(conn, secrets)
  const server: Server = createServer((socket: Socket) => {
    ssh.forwardOut('127.0.0.1', socket.localPort ?? 0, conn.host || '127.0.0.1', conn.port || defaultPort, (err, stream) => {
      if (err) return socket.destroy(err)
      socket.pipe(stream).pipe(socket)
      stream.on('close', () => socket.destroy())
      socket.on('close', () => stream.destroy())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return {
    port,
    cleanup: () => {
      server.close()
      ssh.end()
    }
  }
}

/** Driver options from the Cloud SQL connector (a `stream` factory plus ssl settings). */
export async function cloudSqlOptions(conn: DbConnection, spaceId: string): Promise<{ opts: Record<string, unknown>; cleanup: () => void; iamUser?: string }> {
  const t = conn.tunnel!
  if (!t.instance) throw new Error('Cloud SQL connection without an instance (project:region:instance).')
  const account = t.account ?? gcp.gcpFor(spaceId)?.account
  const connector = new Connector({ auth: new GcloudAuth(account) })
  try {
    const ipType = t.ipType === 'PRIVATE' ? IpAddressTypes.PRIVATE : t.ipType === 'PSC' ? IpAddressTypes.PSC : IpAddressTypes.PUBLIC
    const opts = (await connector.getOptions({ instanceConnectionName: t.instance, ipType, authType: t.iamAuth ? AuthTypes.IAM : AuthTypes.PASSWORD })) as unknown as Record<string, unknown>
    return { opts, cleanup: () => connector.close(), iamUser: t.iamAuth && !conn.user ? account : undefined }
  } catch (err) {
    connector.close()
    const m = err instanceof Error ? err.message : String(err)
    throw new Error(`Cloud SQL connector: ${m}. Check that ${account ?? 'the active gcloud account'} can access ${t.instance} (roles/cloudsql.client) and that the Cloud SQL Admin API is enabled.`)
  }
}
