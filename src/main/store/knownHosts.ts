import Store from 'electron-store'

interface KnownHostsSchema {
  /** "host:port" → sha256 指纹（base64） */
  hosts: Record<string, string>
}

/** known_hosts 指纹库：记录已信任主机的 host key 指纹，用于检测中间人攻击 */
export class KnownHostsStore {
  private store = new Store<KnownHostsSchema>({
    name: 'dox-known-hosts',
    defaults: { hosts: {} }
  })

  get(host: string, port: number): string | undefined {
    return this.store.get('hosts')[`${host}:${port}`]
  }

  set(host: string, port: number, fingerprint: string): void {
    this.store.set('hosts', { ...this.store.get('hosts'), [`${host}:${port}`]: fingerprint })
  }
}
