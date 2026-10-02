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

