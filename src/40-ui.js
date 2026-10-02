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


    function activeControllerName(fallback = 'content') {
        const L = lampa()
        try {
            const enabled = L && L.Controller && L.Controller.enabled && L.Controller.enabled()
            return enabled && enabled.name ? enabled.name : fallback
        } catch (_) {
            return fallback
        }
    }

    function restoreController(name) {
        const L = lampa()
        try {
            if (L && L.Controller && L.Controller.toggle) L.Controller.toggle(name || 'content')
        } catch (_) {}
    }

    function closeRecoveryPage() {
        const L = lampa()
        try {
            const active = L && L.Activity && L.Activity.active && L.Activity.active()
            if (active && active.component === 'torrents') L.Activity.backward()
        } catch (_) {}

        setTimeout(() => {
            try {
                if (L && L.Activity && L.Activity.refresh) L.Activity.refresh()
            } catch (_) {}
        }, 300)
    }


    function sameMovie(a, b) {
        if (!a || !b) return false
        if (a.id && b.id) return String(a.id) === String(b.id)
        return String(a.original_name || a.name || a.title || '') === String(b.original_name || b.name || b.title || '')
    }

    async function openNativeRecovery(hash, movie, files, objectRef) {
        const L = lampa()
        let fullMovie

        try {
            fullMovie = await hydrateMovie(movie)
        } catch (error) {
            warn('Legacy recovery card hydration failed', error)
            if (L && L.Noty) L.Noty.show(text('Не удалось открыть штатный поиск торрентов', 'Could not open native torrent search'))
            return
        }

        const q = parserQuery(fullMovie)
        runtime.recovery = {
            hash: String(hash).toLowerCase(),
            movie: fullMovie,
            files: files || [],
            objectRef: objectRef || null,
            started_at: Date.now()
        }

        L.Activity.push({
            url: '',
            title: text('Выберите раздачу для обновления', 'Choose release for update'),
            component: 'torrents',
            search: q.text,
            search_one: q.one,
            search_two: q.two,
            movie: fullMovie,
            page: 1,
            tor_updater_recovery: true
        })

        if (L && L.Noty) L.Noty.show(text(
            'Выберите нужную раздачу и нажмите OK',
            'Choose the release and press OK'
        ))
    }

    async function useRecoveryCandidate(candidate) {
        const L = lampa()
        const recovery = runtime.recovery
        if (!recovery || !candidate) return

        const hash = recovery.hash
        const movie = recovery.movie
        const identity = releaseIdentity(candidate)

        if (!identity || !resultLink(candidate)) {
            if (L && L.Noty) L.Noty.show(text(
                'У этой раздачи нет стабильного идентификатора для привязки',
                'This release has no stable identity for binding'
            ))
            return
        }

        if (L && L.Noty) L.Noty.show(text('Проверяю выбранную раздачу…', 'Checking selected release…'))

        let oldStatus
        let probe
        try {
            oldStatus = await ts.get(hash)
            probe = await probeCandidate(hash, movie, oldStatus, candidate)
        } catch (error) {
            warn('Legacy recovery probe failed', error)
            if (L && L.Noty) L.Noty.show(text('Не удалось проверить выбранную раздачу', 'Could not verify the selected release'))
            return
        }

        try { if (probe.newHash && probe.newHash !== hash) await ts.drop(probe.newHash) } catch (_) {}

        if (probe.classification === 'incompatible') {
            if (L && L.Noty) L.Noty.show(text(
                'Эта раздача не содержит все серии из текущего торрента',
                'This release does not contain all episodes from the current torrent'
            ))
            return
        }

        if (probe.classification === 'unknown') {
            if (L && L.Noty) L.Noty.show(text(
                'Не удалось надёжно сопоставить серии в этой раздаче',
                'Could not reliably match episodes in this release'
            ))
            return
        }

        const subtitle = probe.classification === 'new_episodes'
            ? `${probe.oldMap.size} → ${probe.newMap.size} ${text('серий', 'episodes')}`
            : text('Та же серия эпизодов, но новая ревизия torrent', 'Same episode set, but a new torrent revision')
        const recoveryController = activeControllerName('content')

        L.Select.show({
            title: text('Привязать эту раздачу?', 'Bind this release?'),
            items: [
                {
                    title: text('Привязать и обновить', 'Bind and update'),
                    subtitle,
                    onSelect: async () => {
                        restoreController(recoveryController)
                        if (L && L.Noty) L.Noty.show(text('Обновляю раздачу…', 'Updating torrent…'))

                        try {
                            const status = await ts.get(hash)
                            await writeFollow(status, {
                                release_key: identity.key,
                                tracker_id: identity.tracker_id,
                                tracker: identity.tracker,
                                identity_via: identity.via,
                                info_hash: String(hash).toLowerCase(),
                                checked_at: 0,
                                episode_count: probe.oldMap.size,
                                persistent: true,
                                legacy_recovered_at: Date.now()
                            })

                            const verified = await probeCandidate(hash, movie, await ts.get(hash), candidate)
                            if (verified.classification === 'incompatible' || verified.classification === 'unknown') {
                                throw new Error('candidate changed during recovery')
                            }

                            await applyUpdate(hash, movie, verified, {
                                manual: true,
                                objectRef: recovery.objectRef
                            })
                            runtime.recovery = null
                            log('Recovered legacy release binding', hash, identity.tracker_id || identity.tracker, identity.via)
                            closeRecoveryPage()
                        } catch (error) {
                            warn('Legacy recovery update failed', error)
                            if (L && L.Noty) L.Noty.show(text(
                                'Не удалось безопасно привязать и обновить раздачу',
                                'Could not safely bind and update the release'
                            ))
                        }
                    }
                },
                {
                    title: text('Отмена', 'Cancel'),
                    onSelect: () => restoreController(recoveryController)
                }
            ],
            onBack: () => restoreController(recoveryController)
        })
    }

    function bindRecoveryTorrentItem(e) {
        const L = lampa()
        const recovery = runtime.recovery
        if (!recovery || !e || e.type !== 'render' || !e.element || !e.item) return
        if (Date.now() - Number(recovery.started_at || 0) > 15 * 60 * 1000) {
            runtime.recovery = null
            return
        }

        let active
        try { active = L.Activity.active() } catch (_) { active = null }
        if (!active || active.component !== 'torrents' || !sameMovie(active.movie, recovery.movie)) return

        try {
            e.item.off('hover:enter')
            e.item.on('hover:enter', () => {
                useRecoveryCandidate(e.element)
            })
        } catch (error) {
            warn('Failed to bind recovery torrent item', error)
        }
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
            await openNativeRecovery(hash, movie, files, objectRef)
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
        const manualController = activeControllerName('content')

        L.Select.show({
            title: text('Найдена новая версия раздачи', 'A new torrent revision is available'),
            items: [
                {
                    title: text('Обновить вручную', 'Update manually'),
                    subtitle,
                    onSelect: async () => {
                        restoreController(manualController)
                        if (L && L.Noty) L.Noty.show(text('Обновляю раздачу…', 'Updating torrent…'))

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
                {
                    title: text('Оставить текущую', 'Keep current'),
                    onSelect: () => restoreController(manualController)
                }
            ],
            onBack: () => restoreController(manualController)
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
        if (!enabled() || !e) return

        if (e.type === 'render') {
            bindRecoveryTorrentItem(e)
            return
        }

        if (e.type !== 'onenter' || !e.element) return
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

