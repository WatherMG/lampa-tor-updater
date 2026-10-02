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
                follow = await bootstrapFollow(hash, movie, files || oldStatus.file_stats || [], options.force)
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
        const candidateData = currentProbe.status ? torrentData(currentProbe.status) : {}
        let newData = mergeMissingMetadata(candidateData, oldData)

        const freshMovie = mergeMissingMetadata(
            candidateData.movie || {},
            mergeMissingMetadata(oldData.movie || {}, movie || {})
        )
        newData = mergeMissingMetadata(newData, { lampa: true, movie: freshMovie })
        newData.lampa = oldData.lampa !== undefined ? oldData.lampa : true
        if (freshMovie && Object.keys(freshMovie).length) newData.movie = freshMovie

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
        const candidateTitle = lampaTorrentTitle(currentProbe.candidate, currentProbe.status && (currentProbe.status.title || currentProbe.status.name))
        const freshPoster = (freshMovie && (freshMovie.poster || freshMovie.img)) || ''
        const meta = {
            title: candidateTitle || (currentProbe.status && currentProbe.status.title) || oldStatus.title || '',
            poster: freshPoster || (currentProbe.status && currentProbe.status.poster) || oldStatus.poster || '',
            category: (currentProbe.status && currentProbe.status.category) || oldStatus.category || 'tv'
        }

        await ts.add(link, meta, persist, newData)
        const newStatus = await waitForFiles(newHash)
        const mergedStatus = Object.assign({}, newStatus, {
            title: meta.title || newStatus.title,
            poster: meta.poster || newStatus.poster,
            category: meta.category || newStatus.category
        })
        await ts.set(newHash, mergedStatus, newData)
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

