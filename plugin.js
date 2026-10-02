/* Lampa Tor Updater v0.1.0 | built 2026-10-03T00:00:00Z | https://github.com/WatherMG/lampa-tor-updater */
(function () {
    'use strict'

    const VERSION = '0.1.0'
    const BUILD_DATE = '2026-10-03T00:00:00Z'
    const COMPONENT = 'tor_updater'
    const FOLLOW_KEY = 'torrent_follow'
    const FOLLOW_VERSION = 1
    const BOOTSTRAP_CACHE_KEY = 'tor_updater_bootstrap'
    const DEFAULT_CHECK_HOURS = 6
    const PROBE_TIMEOUT_MS = 18000
    const VIDEO_EXTENSIONS = new Set(['asf', 'wmv', 'divx', 'avi', 'mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'trp', 'tp', 'mts', 'mpg', 'mpeg', 'dat', 'vob', 'rm', 'rmvb', 'm2ts', 'ts'])

    const runtime = {
        pendingSelection: null,
        checking: new Set(),
        sessions: new Map(),
        candidates: new Map(),
        pendingCleanup: new Map(),
        activePlayerHash: null,
        listHash: null,
        bootstrapping: new Set(),
        notified: new Set()
    }

    function lampa() {
        return typeof window !== 'undefined' ? window.Lampa : null
    }

    function log(...args) {
        if (typeof console !== 'undefined' && console.log) console.log('[TorUpdater]', ...args)
    }

    function debug(...args) {
        const L = lampa()
        let on = false
        try { on = !!(L && L.Storage && L.Storage.field('tor_updater_debug')) } catch (_) {}
        if (on) log(...args)
    }

    function warn(...args) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[TorUpdater]', ...args)
    }

    function text(ru, en) {
        const L = lampa()
        let language = 'ru'
        try { language = L && L.Storage ? L.Storage.field('language') : 'ru' } catch (_) {}
        return language === 'ru' ? ru : en
    }

    function enabled() {
        const L = lampa()
        if (!L || !L.Storage) return false
        try { return L.Storage.field('tor_updater_enabled') !== false } catch (_) { return true }
    }

    function autoUpdateEnabled() {
        const L = lampa()
        if (!L || !L.Storage) return true
        try { return L.Storage.field('tor_updater_auto') !== false } catch (_) { return true }
    }

    function checkIntervalMs() {
        const L = lampa()
        let value = DEFAULT_CHECK_HOURS
        try { value = Number(L.Storage.field('tor_updater_interval') || DEFAULT_CHECK_HOURS) } catch (_) {}
        if (!Number.isFinite(value) || value < 1) value = DEFAULT_CHECK_HOURS
        return value * 60 * 60 * 1000
    }

    function isTruthy(value) {
        return value === true || value === 1 || value === '1' || value === 'true'
    }

    function shouldPersistByDefault() {
        const L = lampa()
        try { return isTruthy(L.Storage.get('torrserver_savedb', false)) } catch (_) { return false }
    }

    function safeJson(value, fallback) {
        if (!value) return fallback
        if (typeof value === 'object') return value
        try { return JSON.parse(value) } catch (_) { return fallback }
    }

    function clone(value) {
        try { return JSON.parse(JSON.stringify(value)) } catch (_) { return value }
    }

    function normalizedString(value) {
        return String(value || '').trim().toLowerCase()
    }

    function normalizeIdentityUrl(value) {
        if (!value) return ''
        const input = String(value).trim()
        if (!input) return ''

        try {
            const u = new URL(input)
            u.hash = ''
            u.hostname = u.hostname.toLowerCase()

            const sensitive = ['apikey', 'api_key', 'passkey', 'token', 'auth', 'authkey', 'key']
            sensitive.forEach((name) => u.searchParams.delete(name))

            const pairs = []
            u.searchParams.forEach((v, k) => pairs.push([k, v]))
            pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
            u.search = ''
            pairs.forEach(([k, v]) => u.searchParams.append(k, v))

            let out = u.toString()
            if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1)
            return out
        } catch (_) {
            return input.replace(/#.*$/, '').replace(/\/$/, '')
        }
    }

    // Two seeded FNV-1a passes. This is an identity token, not a security primitive.
    function stableHash(input) {
        const value = String(input || '')
        let h1 = 0x811c9dc5
        let h2 = 0x9e3779b9
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i)
            h1 ^= code
            h1 = Math.imul(h1, 0x01000193)
            h2 ^= code
            h2 = Math.imul(h2, 0x85ebca6b)
        }
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
    }

    function releaseIdentity(result) {
        if (!result) return null

        const trackerId = normalizedString(result.TrackerId || result.trackerId)
        const tracker = normalizedString(result.Tracker || result.tracker)
        const source = trackerId || tracker
        if (!source) return null

        const details = normalizeIdentityUrl(result.Details || result.details)
        const guid = normalizeIdentityUrl(result.Guid || result.guid)
        const identityUrl = details || guid
        if (!identityUrl) return null

        return {
            version: 1,
            key: stableHash(source + '|' + identityUrl),
            tracker_id: trackerId || '',
            tracker: tracker || '',
            via: details ? 'details' : 'guid'
        }
    }

    function base32ToHex(input) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
        let bits = ''
        let hex = ''
        const clean = String(input || '').toUpperCase().replace(/=+$/, '')

        for (const ch of clean) {
            const val = alphabet.indexOf(ch)
            if (val < 0) return ''
            bits += val.toString(2).padStart(5, '0')
        }

        for (let i = 0; i + 4 <= bits.length; i += 4) {
            hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
        }
        return hex.slice(0, 40)
    }

    function infoHashFromMagnet(uri) {
        if (!uri || !/^magnet:/i.test(String(uri))) return ''
        const match = String(uri).match(/[?&]xt=urn:btih:([^&]+)/i)
        if (!match) return ''
        let value = decodeURIComponent(match[1]).trim()
        if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase()
        if (/^[a-z2-7]{32}$/i.test(value)) return base32ToHex(value).toLowerCase()
        return ''
    }

    function resultInfoHash(result) {
        const direct = String((result && (result.InfoHash || result.infoHash)) || '').trim().toLowerCase()
        if (/^[a-f0-9]{40}$/i.test(direct)) return direct
        if (/^[a-z2-7]{32}$/i.test(direct)) return base32ToHex(direct).toLowerCase()
        return infoHashFromMagnet(result && (result.MagnetUri || result.magnetUri || result.Link || result.link || result.downloadUrl))
    }

    function resultLink(result) {
        return result && (result.MagnetUri || result.magnetUri || result.Link || result.link || result.downloadUrl) || ''
    }

    function sameRelease(follow, result) {
        if (!follow || !follow.release_key) return false
        const identity = releaseIdentity(result)
        return !!identity && identity.key === follow.release_key
    }

    function episodeKey(season, episode) {
        const s = Number(season)
        const e = Number(episode)
        if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 1) return ''
        return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
    }

    function compareEpisodeMaps(oldMap, newMap) {
        const oldKeys = [...oldMap.keys()]
        const newKeys = [...newMap.keys()]
        if (!oldKeys.length || !newKeys.length) return 'unknown'

        const allOldPresent = oldKeys.every((key) => newMap.has(key))
        if (!allOldPresent) return 'incompatible'
        if (newKeys.length > oldKeys.length) return 'new_episodes'
        if (newKeys.length === oldKeys.length) return 'revision'
        return 'incompatible'
    }

    function isTv(movie) {
        return !!(movie && (movie.original_name || movie.name || movie.first_air_date || movie.number_of_seasons))
    }

    function parserQuery(movie) {
        const L = lampa()
        const title = movie.title || movie.name || ''
        const original = movie.original_title || movie.original_name || ''
        const year = String(movie.first_air_date || movie.release_date || '0000').slice(0, 4)
        const combinations = {
            df: original,
            df_year: `${original} ${year}`,
            df_lg: `${original} ${title}`,
            df_lg_year: `${original} ${title} ${year}`,
            lg: title,
            lg_year: `${title} ${year}`,
            lg_df: `${title} ${original}`,
            lg_df_year: `${title} ${original} ${year}`
        }
        let mode = 'df'
        try { mode = L.Storage.field('parse_lang') || 'df' } catch (_) {}
        return {
            one: title,
            two: original,
            text: String(combinations[mode] || combinations.df || title).trim()
        }
    }

    function hydrateMovie(movie) {
        const L = lampa()
        if (!movie || !movie.id || !isTv(movie)) return Promise.reject(new Error('Not a TV card'))
        if (Array.isArray(movie.genres)) return Promise.resolve(movie)

        const tmdb = L && L.Api && L.Api.sources && L.Api.sources.tmdb
        const source = tmdb && typeof tmdb.get === 'function' ? tmdb : (L && L.TMDB)
        if (!source || typeof source.get !== 'function') return Promise.reject(new Error('TMDB source is unavailable'))

        return new Promise((resolve, reject) => {
            source.get(`tv/${movie.id}`, {}, (fresh) => {
                if (!fresh || !Array.isArray(fresh.genres)) return reject(new Error('TMDB card has no genres'))
                resolve(Object.assign({}, fresh, movie, { genres: fresh.genres }))
            }, reject, { life: 60 * 24 })
        })
    }

    async function parserSearch(movie) {
        const L = lampa()
        if (!L || !L.Parser || typeof L.Parser.get !== 'function') throw new Error('Lampa.Parser is unavailable')
        const fullMovie = await hydrateMovie(movie)
        const q = parserQuery(fullMovie)

        return new Promise((resolve, reject) => {
            try {
                L.Parser.get({
                    search: q.text,
                    search_one: q.one,
                    search_two: q.two,
                    movie: fullMovie,
                    page: 1
                }, (data) => resolve((data && data.Results) || []), reject)
            } catch (error) {
                reject(error)
            }
        })
    }

    function newRequest() {
        const L = lampa()
        if (!L || !L.Reguest) throw new Error('Lampa.Reguest is unavailable')
        return new L.Reguest()
    }

    function torrServerUrl() {
        const L = lampa()
        const url = L && L.Torserver && L.Torserver.url && L.Torserver.url()
        if (!url) throw new Error('TorrServer URL is not configured')
        return String(url).replace(/\/$/, '')
    }

    function request(path, payload, timeoutMs) {
        const net = newRequest()
        if (timeoutMs && net.timeout) net.timeout(timeoutMs)

        return new Promise((resolve, reject) => {
            net.silent(torrServerUrl() + path, resolve, (a, c) => {
                const err = new Error(`TorrServer request failed: ${c || a || path}`)
                err.raw = a
                reject(err)
            }, JSON.stringify(payload))
        })
    }

    const ts = {
        get: (hash) => request('/torrents', { action: 'get', hash }, 5000),
        set: (hash, status, data) => request('/torrents', {
            action: 'set',
            hash,
            title: status.title || '',
            poster: status.poster || '',
            category: status.category || '',
            data: JSON.stringify(data || {})
        }, 5000),
        add: (link, meta, saveToDb, data) => request('/torrents', {
            action: 'add',
            link,
            title: meta.title || '',
            poster: meta.poster || '',
            category: meta.category || '',
            data: data ? JSON.stringify(data) : '',
            save_to_db: !!saveToDb
        }, 8000),
        remove: (hash) => request('/torrents', { action: 'rem', hash }, 8000),
        drop: (hash) => request('/torrents', { action: 'drop', hash }, 5000),
        viewed: (hash) => request('/viewed', { action: 'list', hash }, 5000),
        list: () => request('/torrents', { action: 'list' }, 8000),
        setViewed: (hash, fileIndex, timecode) => request('/viewed', {
            action: 'set', hash, file_index: fileIndex, timecode
        }, 5000)
    }

    async function waitForFiles(hash, timeoutMs = PROBE_TIMEOUT_MS) {
        const started = Date.now()
        let last
        while (Date.now() - started < timeoutMs) {
            try {
                last = await ts.get(hash)
                if (last && Array.isArray(last.file_stats) && last.file_stats.length) return last
            } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 1200))
        }
        throw new Error(`Torrent metadata timeout: ${hash}`)
    }

    function episodeMap(movie, files) {
        const L = lampa()
        const map = new Map()
        if (!movie || !files || !files.length || !L || !L.Torserver || !L.Torserver.parse) return map

        const playable = clone(files).filter((file) => {
            const ext = String(file.path || '').split('.').pop().toLowerCase()
            return VIDEO_EXTENSIONS.has(ext)
        })

        try {
            if (L.Torserver.clearFileName) L.Torserver.clearFileName(playable)
        } catch (_) {}

        playable.forEach((file) => {
            try {
                const parsed = L.Torserver.parse({
                    movie,
                    files: playable,
                    filename: file.path_human || file.path,
                    path: file.path
                })
                const key = episodeKey(parsed && parsed.season, parsed && parsed.episode)
                if (key && !map.has(key)) map.set(key, { id: file.id, path: file.path, season: parsed.season, episode: parsed.episode })
            } catch (_) {}
        })

        return map
    }

    function torrentData(status) {
        return safeJson(status && status.data, {}) || {}
    }

    async function writeFollow(status, patch) {
        const data = torrentData(status)
        const current = data[FOLLOW_KEY] || {}
        data[FOLLOW_KEY] = Object.assign({}, current, patch, { version: FOLLOW_VERSION })
        await ts.set(status.hash, status, data)
        return data[FOLLOW_KEY]
    }

    function selectionMetadata(result) {
        const identity = releaseIdentity(result)
        if (!identity) return null
        return {
            identity,
            info_hash: resultInfoHash(result),
            selected_at: Date.now(),
            persistent: shouldPersistByDefault()
        }
    }

    async function bindPendingSelection(hash, movie, files) {
        const pending = runtime.pendingSelection
        if (!pending || !pending.identity) return null
        runtime.pendingSelection = null

        try {
            const status = await ts.get(hash)
            const count = episodeMap(movie, files || status.file_stats || []).size
            const follow = await writeFollow(status, {
                release_key: pending.identity.key,
                tracker_id: pending.identity.tracker_id,
                tracker: pending.identity.tracker,
                identity_via: pending.identity.via,
                info_hash: String(hash).toLowerCase(),
                checked_at: Date.now(),
                episode_count: count,
                persistent: pending.persistent
            })
            log('Bound release identity', hash, follow.tracker_id || follow.tracker, follow.identity_via)
            return follow
        } catch (error) {
            warn('Failed to bind selected release', error)
            return null
        }
    }

    function bootstrapCache() {
        const L = lampa()
        try { return L.Storage.get(BOOTSTRAP_CACHE_KEY, {}) || {} } catch (_) { return {} }
    }

    function setBootstrapAttempt(hash) {
        const L = lampa()
        try {
            const cache = bootstrapCache()
            cache[hash] = Date.now()
            const keys = Object.keys(cache)
            if (keys.length > 200) keys.sort((a, b) => cache[b] - cache[a]).slice(200).forEach((key) => delete cache[key])
            L.Storage.set(BOOTSTRAP_CACHE_KEY, cache)
        } catch (_) {}
    }

    function bootstrapDue(hash) {
        const at = Number(bootstrapCache()[hash] || 0)
        return !at || Date.now() - at > 24 * 60 * 60 * 1000
    }

    async function bootstrapFollow(hash, movie, files) {
        if (runtime.bootstrapping.has(hash) || !bootstrapDue(hash)) return null
        runtime.bootstrapping.add(hash)
        setBootstrapAttempt(hash)

        try {
            const results = await parserSearch(movie)
            const exact = results.filter((result) => resultInfoHash(result) === String(hash).toLowerCase())
            const matched = exact.find((result) => releaseIdentity(result))
            if (!matched) return null

            const identity = releaseIdentity(matched)
            const status = await ts.get(hash)
            const count = episodeMap(movie, files || status.file_stats || []).size
            const follow = await writeFollow(status, {
                release_key: identity.key,
                tracker_id: identity.tracker_id,
                tracker: identity.tracker,
                identity_via: identity.via,
                info_hash: String(hash).toLowerCase(),
                checked_at: Date.now(),
                episode_count: count,
                persistent: true
            })
            log('Bootstrapped existing torrent', hash)
            return follow
        } catch (error) {
            log('Bootstrap skipped', hash, error && error.message)
            return null
        } finally {
            runtime.bootstrapping.delete(hash)
        }
    }

    function chooseReleaseCandidate(follow, results, currentHash) {
        const matches = results.filter((result) => sameRelease(follow, result))
        if (!matches.length) return null

        matches.sort((a, b) => {
            const ah = resultInfoHash(a)
            const bh = resultInfoHash(b)
            if (ah !== currentHash && bh === currentHash) return -1
            if (ah === currentHash && bh !== currentHash) return 1
            return Number(b.PublisTime || b.PublishDate || 0) - Number(a.PublisTime || a.PublishDate || 0)
        })
        return matches[0]
    }

    async function probeCandidate(oldHash, movie, oldStatus, candidate) {
        const link = resultLink(candidate)
        if (!link) throw new Error('Candidate has no torrent link')

        const data = torrentData(oldStatus)
        const meta = {
            title: oldStatus.title || '',
            poster: oldStatus.poster || '',
            category: oldStatus.category || 'tv'
        }

        const added = await ts.add(link, meta, false, null)
        const newHash = String((added && added.hash) || resultInfoHash(candidate) || '').toLowerCase()
        if (!newHash) throw new Error('TorrServer did not return candidate hash')
        if (newHash === String(oldHash).toLowerCase()) {
            return { classification: 'same', newHash, status: oldStatus, candidate, oldMap: episodeMap(movie, oldStatus.file_stats || []), newMap: episodeMap(movie, oldStatus.file_stats || []), data }
        }

        let newStatus
        try {
            newStatus = await waitForFiles(newHash)
        } catch (error) {
            try { await ts.drop(newHash) } catch (_) {}
            throw error
        }

        const oldMap = episodeMap(movie, oldStatus.file_stats || [])
        const newMap = episodeMap(movie, newStatus.file_stats || [])
        const classification = compareEpisodeMaps(oldMap, newMap)

        return { classification, newHash, status: newStatus, candidate, oldMap, newMap, data, link }
    }

    async function markChecked(status, follow, extra) {
        try {
            return await writeFollow(status, Object.assign({}, extra || {}, {
                checked_at: Date.now(),
                info_hash: String(status.hash || follow.info_hash || '').toLowerCase()
            }))
        } catch (_) {
            return follow
        }
    }

    function candidateSummary(probe) {
        return {
            candidate: probe.candidate,
            classification: probe.classification,
            old_count: probe.oldMap.size,
            new_count: probe.newMap.size,
            found_at: Date.now()
        }
    }

    function notifyCandidate(hash, probe) {
        if (runtime.notified.has(hash)) return
        runtime.notified.add(hash)
        const L = lampa()
        if (!L || !L.Noty) return
        const suffix = probe.classification === 'new_episodes' && probe.newMap.size > probe.oldMap.size
            ? `: ${probe.oldMap.size} → ${probe.newMap.size}`
            : ''
        L.Noty.show(text('Найдена новая версия раздачи', 'A new torrent revision is available') + suffix)
    }


    async function checkForUpdate(hash, movie, files, options) {
        options = options || {}
        hash = String(hash || '').toLowerCase()
        if (!enabled() || !hash || !movie || !isTv(movie)) return { kind: 'skipped' }
        if (runtime.checking.has(hash)) return { kind: 'busy' }

        runtime.checking.add(hash)
        try {
            const oldStatus = await ts.get(hash)
            let data = torrentData(oldStatus)
            let follow = data[FOLLOW_KEY]

            if (follow && follow.superseded_by) return { kind: 'superseded', hash: follow.superseded_by }

            if (!follow || !follow.release_key) {
                follow = await bootstrapFollow(hash, movie, files || oldStatus.file_stats || [])
                if (!follow) return { kind: 'unbound' }
                data = torrentData(await ts.get(hash))
            }

            if (!options.force && follow.checked_at && Date.now() - Number(follow.checked_at) < checkIntervalMs()) {
                return { kind: 'fresh' }
            }

            const results = await parserSearch(movie)
            const candidate = chooseReleaseCandidate(follow, results, hash)
            if (!candidate) {
                await markChecked(oldStatus, follow)
                runtime.candidates.delete(hash)
                return { kind: 'not_found' }
            }

            const advertisedHash = resultInfoHash(candidate)
            if (advertisedHash && advertisedHash === hash) {
                await markChecked(oldStatus, follow)
                runtime.candidates.delete(hash)
                return { kind: 'same' }
            }

            const probe = await probeCandidate(hash, movie, oldStatus, candidate)
            await markChecked(oldStatus, follow, { last_result: probe.classification })

            if (probe.classification === 'same') {
                runtime.candidates.delete(hash)
                return { kind: 'same' }
            }

            runtime.candidates.set(hash, candidateSummary(probe))

            if (probe.classification === 'new_episodes' && autoUpdateEnabled() && options.allowAuto !== false) {
                const applied = await applyUpdate(hash, movie, probe, options)
                return { kind: 'updated', applied }
            }

            try { await ts.drop(probe.newHash) } catch (_) {}

            if (probe.classification === 'revision' || probe.classification === 'unknown' || probe.classification === 'new_episodes') {
                notifyCandidate(hash, probe)
                return { kind: 'available', probe: candidateSummary(probe) }
            }

            return { kind: 'incompatible' }
        } catch (error) {
            log('Check failed; leaving Lampa flow untouched', hash, error && error.message)
            return { kind: 'error', error }
        } finally {
            runtime.checking.delete(hash)
        }
    }

    async function transferViewed(oldHash, newHash, oldMap, newMap) {
        let viewed = []
        try { viewed = await ts.viewed(oldHash) } catch (_) { return }
        if (!Array.isArray(viewed) || !viewed.length) return

        const oldByIndex = new Map()
        oldMap.forEach((value, key) => oldByIndex.set(Number(value.id), key))

        for (const mark of viewed) {
            const key = oldByIndex.get(Number(mark.file_index))
            const target = key && newMap.get(key)
            if (!target || !mark.timecode) continue
            try { await ts.setViewed(newHash, target.id, mark.timecode) } catch (_) {}
        }
    }

    function hashBusy(hash) {
        return runtime.activePlayerHash === hash || runtime.listHash === hash
    }

    async function cleanupOld(hash) {
        if (!hash || hashBusy(hash)) return false
        try {
            await ts.remove(hash)
            runtime.pendingCleanup.delete(hash)
            log('Removed superseded torrent', hash)
            return true
        } catch (error) {
            warn('Failed to remove superseded torrent', hash, error)
            return false
        }
    }

    async function applyUpdate(oldHash, movie, probe, options) {
        options = options || {}
        const oldStatus = await ts.get(oldHash)
        const oldData = torrentData(oldStatus)
        const follow = oldData[FOLLOW_KEY] || {}
        const identity = releaseIdentity(probe.candidate)
        if (!identity || identity.key !== follow.release_key) throw new Error('Release identity changed during update')
        if (probe.classification === 'incompatible') throw new Error('Candidate does not contain all current episodes')

        let currentProbe = probe
        if (!probe.newHash || !probe.status || !probe.status.file_stats) {
            currentProbe = await probeCandidate(oldHash, movie, oldStatus, probe.candidate)
        }

        const link = resultLink(currentProbe.candidate)
        if (!link) throw new Error('Candidate link is unavailable')

        const newHash = String(currentProbe.newHash).toLowerCase()
        const newData = clone(oldData)
        newData[FOLLOW_KEY] = Object.assign({}, follow, {
            version: FOLLOW_VERSION,
            release_key: identity.key,
            tracker_id: identity.tracker_id,
            tracker: identity.tracker,
            identity_via: identity.via,
            info_hash: newHash,
            checked_at: Date.now(),
            episode_count: currentProbe.newMap.size,
            last_result: currentProbe.classification,
            previous_hash: oldHash
        })

        const persist = follow.persistent !== false
        const meta = {
            title: oldStatus.title || '',
            poster: oldStatus.poster || '',
            category: oldStatus.category || 'tv'
        }

        await ts.add(link, meta, persist, newData)
        const newStatus = await waitForFiles(newHash)
        await ts.set(newHash, newStatus, newData)
        await transferViewed(oldHash, newHash, currentProbe.oldMap, currentProbe.newMap)

        try { await writeFollow(oldStatus, { superseded_by: newHash, checked_at: Date.now(), last_result: 'superseded' }) } catch (_) {}

        runtime.pendingCleanup.set(oldHash, newHash)
        const activeComponent = currentComponent()
        if (!hashBusy(oldHash) && activeComponent !== 'mytorrents') await cleanupOld(oldHash)

        runtime.candidates.delete(oldHash)
        runtime.notified.delete(oldHash)

        const L = lampa()
        if (L && L.Noty) {
            if (currentProbe.classification === 'new_episodes') {
                L.Noty.show(text('Раздача обновлена', 'Torrent updated') + `: ${currentProbe.oldMap.size} → ${currentProbe.newMap.size}`)
            } else {
                L.Noty.show(text('Версия раздачи обновлена', 'Torrent revision updated'))
            }
        }

        if (options.objectRef) {
            options.objectRef.hash = newHash
            options.objectRef.data = newData
        }

        return { oldHash, newHash, classification: currentProbe.classification }
    }


    function currentComponent() {
        const L = lampa()
        try {
            const active = L && L.Activity && L.Activity.active && L.Activity.active()
            return active && active.component || ''
        } catch (_) { return '' }
    }

    async function cleanupPersistedSuperseded() {
        try {
            const list = await ts.list()
            if (!Array.isArray(list) || !list.length) return
            const hashes = new Set(list.map((item) => String(item.hash || '').toLowerCase()).filter(Boolean))
            for (const item of list) {
                const hash = String(item.hash || '').toLowerCase()
                const data = torrentData(item)
                const follow = data[FOLLOW_KEY]
                const target = follow && String(follow.superseded_by || '').toLowerCase()
                if (hash && target && hashes.has(target) && !hashBusy(hash)) {
                    await cleanupOld(hash)
                }
            }
        } catch (error) {
            debug('Persisted cleanup skipped', error && error.message)
        }
    }

    function currentSession(hash) {
        return runtime.sessions.get(hash) || null
    }

    async function manualCheck(hash, movie, files, objectRef) {
        const L = lampa()
        if (L && L.Noty) L.Noty.show(text('Проверяю обновление…', 'Checking for updates…'))

        const result = await checkForUpdate(hash, movie, files, { force: true, allowAuto: false })
        if (result.kind === 'same' || result.kind === 'not_found' || result.kind === 'fresh') {
            if (L && L.Noty) L.Noty.show(text('Новых версий раздачи нет', 'No new torrent revision found'))
            return
        }
        if (result.kind === 'unbound') {
            if (L && L.Noty) L.Noty.show(text('Не удалось точно связать торрент с исходной раздачей', 'Could not bind this torrent to an exact tracker release'))
            return
        }
        if (result.kind === 'incompatible') {
            if (L && L.Noty) L.Noty.show(text('Новая версия не прошла безопасную проверку', 'The new revision failed the safe compatibility check'))
            return
        }
        if (result.kind !== 'available') return

        const cached = runtime.candidates.get(hash)
        if (!cached) return

        const subtitle = cached.classification === 'new_episodes'
            ? `${cached.old_count} → ${cached.new_count} ${text('серий', 'episodes')}`
            : text('Изменился infohash той же раздачи', 'The same release has a new infohash')

        L.Select.show({
            title: text('Найдена новая версия раздачи', 'A new torrent revision is available'),
            items: [
                {
                    title: text('Обновить вручную', 'Update manually'),
                    subtitle,
                    onSelect: async () => {
                        try {
                            const oldStatus = await ts.get(hash)
                            const probe = await probeCandidate(hash, movie, oldStatus, cached.candidate)
                            if (probe.classification === 'incompatible') throw new Error('incompatible')
                            await applyUpdate(hash, movie, probe, { manual: true, objectRef })
                        } catch (error) {
                            warn('Manual update failed', error)
                            L.Noty.show(text('Не удалось безопасно обновить раздачу', 'Could not safely update the torrent'))
                        }
                    }
                },
                { title: text('Оставить текущую', 'Keep current') }
            ]
        })
    }

    function addUpdateMenu(menu, hash, movie, files, objectRef) {
        if (!enabled() || !hash || !movie || !isTv(movie) || !Array.isArray(menu)) return
        const cached = runtime.candidates.get(hash)
        const controller = (() => {
            const L = lampa()
            try { return L.Controller.enabled().name } catch (_) { return 'content' }
        })()

        if (cached && ['revision', 'unknown', 'new_episodes'].includes(cached.classification)) {
            menu.push({
                title: text('Обновить раздачу', 'Update torrent'),
                subtitle: cached.classification === 'new_episodes'
                    ? `${text('Найдена новая версия', 'New revision found')}: ${cached.old_count} → ${cached.new_count}`
                    : text('Найдена новая версия раздачи', 'A new torrent revision is available'),
                onSelect: () => {
                    const L = lampa()
                    try { L.Controller.toggle(controller) } catch (_) {}
                    manualCheck(hash, movie, files, objectRef)
                }
            })
        }

        menu.push({
            title: text('Проверить обновление', 'Check for update'),
            subtitle: text('Только точное совпадение исходной раздачи', 'Exact tracker release match only'),
            onSelect: () => {
                const L = lampa()
                try { L.Controller.toggle(controller) } catch (_) {}
                manualCheck(hash, movie, files, objectRef)
            }
        })
    }

    function onTorrent(e) {
        if (!enabled() || !e || e.type !== 'onenter' || !e.element) return
        const metadata = selectionMetadata(e.element)
        runtime.pendingSelection = metadata
        debug('Parser selection', {
            tracker: e.element.Tracker || '',
            trackerId: e.element.TrackerId || '',
            hasDetails: !!e.element.Details,
            hasGuid: !!e.element.Guid,
            hasInfoHash: !!resultInfoHash(e.element),
            releaseKey: metadata && metadata.identity && metadata.identity.key
        })
        if (!metadata) log('Selected result has no stable Details/Guid identity; updater will not bind it')
    }

    function onTorrentFile(e) {
        if (!enabled() || !e) return

        if (e.type === 'list_close') {
            const oldHash = runtime.listHash
            runtime.listHash = null
            if (oldHash && runtime.pendingCleanup.has(oldHash) && runtime.activePlayerHash !== oldHash) cleanupOld(oldHash)
            return
        }

        if (e.type === 'render' && e.element) {
            const hash = String(e.element.torrent_hash || '').toLowerCase()
            const movie = e.params && e.params.movie || e.element.card
            if (!hash || !movie || !isTv(movie)) return

            runtime.listHash = hash
            if (!runtime.sessions.has(hash)) runtime.sessions.set(hash, { movie, files: e.items || [], checked: false })
            const session = runtime.sessions.get(hash)
            session.movie = movie
            session.files = e.items || session.files || []

            if (!session.bound) {
                session.bound = true
                bindPendingSelection(hash, movie, session.files).finally(() => {
                    if (!session.checked) {
                        session.checked = true
                        checkForUpdate(hash, movie, session.files, { allowAuto: currentComponent() !== 'mytorrents' })
                    }
                })
            }
            return
        }

        if (e.type === 'onlong' && e.element && e.menu) {
            const hash = String(e.element.torrent_hash || '').toLowerCase()
            const movie = e.params && e.params.movie || e.element.card
            const session = currentSession(hash)
            addUpdateMenu(e.menu, hash, movie, session && session.files || e.items || [], null)
        }
    }

    function onActivity(e) {
        if (!e || e.type !== 'destroy' || e.component !== 'mytorrents') return
        const hashes = [...runtime.pendingCleanup.keys()]
        hashes.forEach((hash) => { if (!hashBusy(hash)) cleanupOld(hash) })
    }

    function onMyTorrents(e) {
        if (!enabled() || !e || e.type !== 'onlong' || !e.object || !e.menu) return
        const object = e.object
        const movie = object.data && object.data.movie
        const hash = String(object.hash || '').toLowerCase()
        const session = currentSession(hash)
        addUpdateMenu(e.menu, hash, movie, session && session.files || object.file_stats || [], object)
    }

    function onPlayerStart(data) {
        runtime.activePlayerHash = data && data.torrent_hash ? String(data.torrent_hash).toLowerCase() : null
    }

    function onPlayerDestroy() {
        const old = runtime.activePlayerHash
        runtime.activePlayerHash = null
        if (old && runtime.pendingCleanup.has(old) && runtime.listHash !== old) cleanupOld(old)
    }


    function registerSettings() {
        const L = lampa()
        if (!L || !L.SettingsApi) return

        try {
            L.SettingsApi.addComponent({
                component: COMPONENT,
                name: text('Обновление сериалов', 'Torrent updater'),
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4V1L8 5l4 4V6a6 6 0 1 1-5.65 4H4.26A8 8 0 1 0 12 4Z"/></svg>'
            })

            L.SettingsApi.addParam({
                component: COMPONENT,
                param: { name: 'tor_updater_enabled', type: 'trigger', default: true },
                field: {
                    name: text('Следить за обновлениями раздач', 'Follow torrent revisions'),
                    description: text('Плагин не меняет штатный поиск Lampa и работает только при точном совпадении раздачи.', 'Does not replace Lampa search and only acts on exact release matches.')
                }
            })

            L.SettingsApi.addParam({
                component: COMPONENT,
                param: { name: 'tor_updater_auto', type: 'trigger', default: true },
                field: {
                    name: text('Автообновление при новых сериях', 'Auto-update when new episodes appear'),
                    description: text('Автоматически заменять только если новая версия содержит все старые серии и добавляет новые.', 'Replace automatically only when the new revision is a strict episode superset.')
                }
            })

            L.SettingsApi.addParam({
                component: COMPONENT,
                param: { name: 'tor_updater_interval', type: 'select', values: '1,3,6,12,24', default: String(DEFAULT_CHECK_HOURS) },
                field: {
                    name: text('Интервал фоновой проверки, часы', 'Background check interval, hours'),
                    description: text('Проверка выполняется лениво при открытии торрента.', 'Checks run lazily when a torrent is opened.')
                }
            })

            L.SettingsApi.addParam({
                component: COMPONENT,
                param: { name: 'tor_updater_debug', type: 'trigger', default: false },
                field: {
                    name: text('Диагностический лог', 'Diagnostic logging'),
                    description: text('Пишет безопасную сводку полей parser result без URL и magnet.', 'Logs a safe parser-result field summary without URLs or magnets.')
                }
            })

            L.SettingsApi.addParam({
                component: COMPONENT,
                param: { type: 'title' },
                field: { name: `Lampa Tor Updater v${VERSION}` }
            })
        } catch (error) {
            warn('Settings registration failed', error)
        }
    }

    function install() {
        const L = lampa()
        if (!L || !L.Listener || !L.Player) return
        if (window.__lampa_tor_updater_installed) return
        window.__lampa_tor_updater_installed = true

        registerSettings()
        L.Listener.follow('torrent', onTorrent)
        L.Listener.follow('torrent_file', onTorrentFile)
        L.Listener.follow('mytorrents', onMyTorrents)
        L.Listener.follow('activity', onActivity)
        L.Player.listener.follow('start', onPlayerStart)
        L.Player.listener.follow('destroy', onPlayerDestroy)

        setTimeout(cleanupPersistedSuperseded, 2000)
        log(`v${VERSION} installed`, BUILD_DATE)
    }

    function init() {
        const L = lampa()
        if (!L) return
        if (typeof window !== 'undefined' && window.appready) install()
        else if (L.Listener && L.Listener.follow) {
            const ready = (e) => {
                if (e && e.type === 'ready') {
                    try { L.Listener.remove('app', ready) } catch (_) {}
                    install()
                }
            }
            L.Listener.follow('app', ready)
        }
    }

    if (typeof globalThis !== 'undefined' && globalThis.__LAMPA_TOR_UPDATER_TEST__) {
        globalThis.LampaTorUpdaterInternals = {
            normalizeIdentityUrl,
            stableHash,
            releaseIdentity,
            base32ToHex,
            infoHashFromMagnet,
            resultInfoHash,
            sameRelease,
            episodeKey,
            compareEpisodeMaps,
            parserQuery
        }
    }

    if (typeof window !== 'undefined') init()
})()

