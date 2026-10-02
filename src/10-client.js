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
