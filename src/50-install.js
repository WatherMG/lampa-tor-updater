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
            parserQuery,
            mergeMissingMetadata,
            lampaTorrentTitle,
            lampaMovieTitle,
            metadataRefreshTitle,
            playableFileCount
        }
    }

    if (typeof window !== 'undefined') init()
})()
