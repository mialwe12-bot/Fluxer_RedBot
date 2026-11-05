# Projektkontext für Claude

Modularer Fluxer-Bot nach Red-DiscordBot-Vorbild. Alle Bot-Texte, das README und die Antworten sind auf Deutsch, über i18n (`locales/de.json`, `cogs/*/locales/de.json`).

## Zielumgebung
- Selbst gehostete Fluxer-Instanz: https://chat.nebendahl.eu (API-Annahme: `/api`, Version v1, Discovery über `/.well-known/fluxer`)
- Jellyfin des Nutzers: jellyfin.mrcoolgamer.de (Phase 4 jellyfinmusic)
- Cog-Quellen: Forgejo des Nutzers (Downloader, HTTPS mit Token)
- Betrieb per Docker Compose, Volume `/data`

## Architekturentscheidungen
- Transport: `@fluxerjs/rest` + `@fluxerjs/ws` (rohe Payloads, eigener Cache in `src/platform/platform.ts`)
- Cogs werden beim Laden mit esbuild zu einer ESM-Datei in `.cogcache/` gebündelt und per `import()` geladen. Das ist der Hot-Reload, inklusive Untermodulen.
- `@bot/sdk` (`src/sdk/index.ts`) ist zustandslos und wird in jeden Cog gebündelt. Fehlerklassen erkennt der Bot deshalb am `name`, nicht per `instanceof`.
- Config: SQLite-Tabelle `config(namespace, scope, scope_id, key, value)`, synchrone API
- Rechte: `src/permissions/permissions.ts`, Tabelle `permission_rules`, Red-Reihenfolge
- Befehle im Slash-Format (`src/commands/types.ts`), Prefix-Erweiterungen `rest`/`variadic`
- Beschreibungen gettext-artig übersetzbar (deutscher Text = Schlüssel)

## Fluxer-Fakten (Recherche Okt. 2026)
- Keine Intents, keine Interactions/Buttons/Slash-Commands
- Gateway-URL aus `GET /gateway/bot`, unverändert nutzen
- Voice: VOICE_STATE_UPDATE ja; Audio über LiveKit: `src/platform/voiceService.ts` (op 4 mit mutation_id → VOICE_SERVER_UPDATE/VOICE_STATE_ACK → `LiveKitRtcConnection` aus @fluxerjs/voice mit Stub-Client). `bot.voice.join/playAndWait/leave`. play() erwartet WebM/Opus; kein end-Event → Polling von `playing`. Gegen echte Instanz ungetestet
- PRESENCE_UPDATE hat `activities`; ob Spiele gemeldet werden, ist unklar
- Member-PATCH: `channel_id` (verschieben), `communication_disabled_until` + `timeout_reason` (Timeout)

## Phasen
1. Kern + example/permissions/downloader ✅
2. admin, alias, mod, modlog, extendedmodlog, mutes, warnings, automod, filter, retrigger, inviteblocklist, cleanup, reports, roletools ✅
3. general, customcom, welcome, suggestions, tickets, levelup, badges, economy, trivia, bingo, conversions, eventposter, streams, image, instadl ✅
4. afkchannel, untis, animewatch, dailystats, birthday, gameblacklist, jellyfinmusic ✅
5. audio, Downloader-Erweiterungen ✅

Nach jeder Phase fragt Claude, ob es weitergeht.

## Konventionen (Phase 2)
- Cog-übergreifende APIs: `cog.expose(api)` / `bot.cogApi<T>('name')`; Typen per `import type` aus `../<cog>/index.js`
- Moderations-Cogs legen Fälle über `modlog` an; Immunität über `bot.isImmune()`, Hierarchie über `bot.hierarchyProblem()`
- Optionale Zahl/Dauer vor freiem Text: Option `rest` + `takeInteger`/`takeDuration` aus dem SDK
- Tests der Cogs: `tests/phase2.test.ts` (FakeRest, `platform.handleDispatch`)

## Konventionen (Phase 3)
- Eigene Bot-Events: `cog.emit('camelCase', …)`, Empfang mit `cog.on('camelCase')`; GROSS_SCHREIBUNG = Gateway
- Externe APIs über `fetchJson`/`fetchText`/`fetchBuffer` aus dem SDK (Timeout, User-Agent), `cog.signal` übergeben
- APIs: economy (`EconomyApi`), levelup (`LevelupApi`, Event `levelUp`), mutes, warnings, modlog
- Config-`get<T>()` hat nur noch die generische Überladung (vorher lieferte `get<string>` fälschlich `unknown`)
- yt-dlp liegt im Docker-Image (`/usr/local/bin/yt-dlp`), wird von instadl und später audio/jellyfinmusic genutzt

## Konventionen (Phase 4)
- `bot.voice` (VoiceService); Musik-API von jellyfinmusic (`MusicApi`: enqueue, queue, setLoop, shuffle, skip, stop, resolveQuery) → Basis für Phase-5-Cog `audio`
- untis: Schlüssel UNTIS_ENCRYPTION_KEY (hex/base64, 32 Byte); `untis login` in Servern wird immer gelöscht (Listener)
- dailystats/levelup zählen keine Befehle (Prefix-Nachrichten)
- Tests: Fake-LiveKit (`FakeRtc`), `globalThis.fetch` für AniList fälschen, `scheduler.runNow`

## Konventionen (Phase 5)
- Musik-Regeln: `MusicApi.addGuard(guard)` (jellyfinmusic) → audio registriert DJ/Vote-Skip/Limits/Jukebox; Rückgabe null | Text | 'vote'
- audio `roleOf`: privileged (Mod/DJ-Rolle: keine Limits/Kosten, fremde Playlists ändern) vs. control (darf steuern; ohne DJ-Rolle und ohne Vote-Skip alle)
- Downloader: `runUpdates(names, install)`, `installVersion` (fetch --depth 1 + git archive + tar), pinned/revision in InstalledEntry, Auto-Update-Task meldet je Hash einmal
- Tests: `tests/phase5.test.ts` nutzt ein echtes lokales Git-Repo

## Befehle
- `npm test`, `npm run typecheck`, `npm run build`
