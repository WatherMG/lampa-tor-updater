import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const src = new URL('../src/', import.meta.url)
const names = (await (await import('node:fs/promises')).readdir(src)).filter((name) => name.endsWith('.js')).sort()
const source = (await Promise.all(names.map((name) => readFile(new URL(name, src), 'utf8')))).join('\n')
const context = { console, URL, setTimeout, clearTimeout, globalThis: null, __LAMPA_TOR_UPDATER_TEST__: true }
context.globalThis = context
vm.createContext(context)
vm.runInContext(source, context)
const api = context.LampaTorUpdaterInternals

test('release identity follows tracker + Details and ignores title/hash changes', () => {
    const before = api.releaseIdentity({
        TrackerId: 'rutracker',
        Tracker: 'RuTracker',
        Details: 'https://rutracker.org/forum/viewtopic.php?t=123',
        Title: 'Show S01E01-E03',
        InfoHash: 'a'.repeat(40)
    })
    const after = api.releaseIdentity({
        TrackerId: 'rutracker',
        Tracker: 'RuTracker',
        Details: 'https://rutracker.org/forum/viewtopic.php?t=123',
        Title: 'Show S01E01-E04 [updated]',
        InfoHash: 'b'.repeat(40)
    })
    assert.equal(before.key, after.key)
})

test('release identity changes for another tracker topic', () => {
    const a = api.releaseIdentity({ TrackerId: 'rutracker', Details: 'https://rutracker.org/forum/viewtopic.php?t=123' })
    const b = api.releaseIdentity({ TrackerId: 'rutracker', Details: 'https://rutracker.org/forum/viewtopic.php?t=124' })
    assert.notEqual(a.key, b.key)
})

test('sensitive query parameters are excluded from release identity', () => {
    const a = api.releaseIdentity({ TrackerId: 'x', Details: 'https://tracker.test/topic?id=42&passkey=SECRET' })
    const b = api.releaseIdentity({ TrackerId: 'x', Details: 'https://tracker.test/topic?passkey=OTHER&id=42' })
    assert.equal(a.key, b.key)
})

test('magnet infohash supports hexadecimal btih', () => {
    const hash = '0123456789abcdef0123456789abcdef01234567'
    assert.equal(api.infoHashFromMagnet(`magnet:?xt=urn:btih:${hash}&dn=test`), hash)
})

test('magnet infohash supports base32 btih', () => {
    assert.equal(api.infoHashFromMagnet('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), '0'.repeat(40))
})

test('resultInfoHash supports direct base32 InfoHash', () => {
    assert.equal(api.resultInfoHash({ InfoHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), '0'.repeat(40))
})

test('episode comparison only auto-updates strict supersets', () => {
    const oldMap = new Map([['S01E01', {}], ['S01E02', {}], ['S01E03', {}]])
    const newer = new Map([...oldMap, ['S01E04', {}]])
    const revision = new Map(oldMap)
    const incompatible = new Map([['S01E01', {}], ['S01E02', {}], ['S01E04', {}]])

    assert.equal(api.compareEpisodeMaps(oldMap, newer), 'new_episodes')
    assert.equal(api.compareEpisodeMaps(oldMap, revision), 'revision')
    assert.equal(api.compareEpisodeMaps(oldMap, incompatible), 'incompatible')
})

test('sameRelease does not compare title', () => {
    const identity = api.releaseIdentity({ TrackerId: 'rutor', Details: 'https://rutor.info/torrent/777' })
    const follow = { release_key: identity.key }
    assert.equal(api.sameRelease(follow, {
        TrackerId: 'rutor',
        Details: 'https://rutor.info/torrent/777',
        Title: 'completely changed title'
    }), true)
})
