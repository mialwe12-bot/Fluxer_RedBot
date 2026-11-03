# fluxer-redbot

Ein modularer Bot für die Chat-Plattform **Fluxer**, gebaut nach dem Vorbild von
[Red-DiscordBot](https://github.com/Cog-Creators/Red-DiscordBot): ein schlanker Kern, dazu
**Cogs** (Plugins), die sich zur Laufzeit laden, entladen und neu laden lassen, ohne Neustart.

- Läuft gegen eine **selbst gehostete Fluxer-Instanz** (hier: `https://chat.nebendahl.eu`). Alles kommt aus der `.env`, nichts ist hartcodiert.
- Node.js 22, TypeScript (ESM), SQLite (`better-sqlite3`) mit einer Red-ähnlichen Config-API
- Prefix-Befehle (Standard `!`, pro Server änderbar, Erwähnung des Bots geht immer) und Reaktionen statt Buttons
- Befehle intern im Slash-Command-Format, damit sich native Slash-Commands später ergänzen lassen
- Docker (multi-stage, non-root), Healthcheck, Watchdog, Auto-Reconnect, Zeitzone Europe/Berlin

> **Stand:** Phasen 1–4 sind fertig (Kern, Moderation, Community, Spezial-Cogs). Phase 5 (audio, Downloader-Erweiterungen) folgt, siehe [Cog-Status](#cog-status).

---

## Inhalt

1. [Projektstruktur](#projektstruktur)
2. [Schnellstart mit Docker](#schnellstart-mit-docker)
3. [Konfiguration (.env)](#konfiguration-env)
4. [Kernbefehle](#kernbefehle)
5. [Berechtigungen](#berechtigungen)
6. [Downloader: Cogs aus Git-Repos](#downloader-cogs-aus-git-repos)
7. [Cogs entwickeln](#cogs-entwickeln)
8. [Cogs im Detail](#cogs-im-detail)
9. [Cog-Status](#cog-status)
10. [Fluxer: Einschränkungen und Annahmen](#fluxer-einschränkungen-und-annahmen)
11. [Entwicklung und Tests](#entwicklung-und-tests)
12. [Betrieb](#betrieb)

---

## Projektstruktur

```
fluxer-redbot/
├── Dockerfile                  # multi-stage, läuft als User "node"
├── docker-compose.yml          # Volume /data, Restart-Policy, Healthcheck
├── .env.example                # vorbelegt mit chat.nebendahl.eu
├── package.json / tsconfig*.json / vitest.config.ts
├── locales/
│   └── de.json                 # Texte des Kerns (i18n, weitere Sprachen: en.json …)
├── src/
│   ├── index.ts                # Einstieg: Discovery, REST, Gateway, Bot starten
│   ├── bot.ts                  # Kern: verbindet alle Teile, Senden mit Embed-Fallback, Healthcheck
│   ├── env.ts                  # .env lesen
│   ├── logger.ts               # strukturiertes Logging (pino)
│   ├── healthcheck.ts          # Docker-Healthcheck
│   ├── platform/
│   │   ├── platform.ts         # Fluxer-REST + Gateway, Cache (Guilds, Rollen, Kanäle, Mitglieder, Voice)
│   │   ├── permissionBits.ts   # Rechte-Bits und Berechnung inkl. Kanal-Overwrites
│   │   ├── types.ts            # Typen (basierend auf @fluxerjs/types)
│   │   ├── voice.ts            # Voice-Fähigkeiten, Fehlerklasse
│   │   └── voiceService.ts     # Sprachkanal-Handshake + LiveKit-Audio (experimentell)
│   ├── cogs/
│   │   ├── cog.ts              # Laufzeitobjekt eines Cogs (an setup() übergeben)
│   │   └── loader.ts           # Laden/Entladen/Neuladen (esbuild-Bundle + import())
│   ├── commands/
│   │   ├── types.ts            # Befehlsdefinition im Slash-Command-Format
│   │   ├── parser.ts           # Argumente: Text, Zahl, ja/nein, Benutzer, Rolle, Kanal …
│   │   ├── registry.ts         # Befehle, Gruppen, Aliase
│   │   ├── dispatcher.ts       # Prefix-Erkennung, Prüfungen, Fehler-Handler
│   │   ├── context.ts          # ctx.reply/send/paginate/confirm/choose …
│   │   ├── cooldowns.ts
│   │   └── errors.ts
│   ├── config/config.ts        # Red-ähnliche Config-API
│   ├── db/database.ts          # SQLite + Migrationen
│   ├── permissions/permissions.ts  # Stufen + Erlauben/Verbieten-Regeln
│   ├── scheduler/scheduler.ts  # Cron/Intervall/Einmal-Tasks (Europe/Berlin)
│   ├── i18n/i18n.ts            # Übersetzungen
│   ├── core/
│   │   ├── coreCog.ts          # Kernbefehle (load, help, set, …)
│   │   └── help.ts             # Hilfe-Ausgabe mit Kategorien
│   ├── utils/                  # Embeds, Formatierung, Reaktions-Menüs
│   └── sdk/index.ts            # öffentliche API für Cogs: import … from '@bot/sdk'
├── cogs/                       # mitgelieferte Cogs
│   ├── example/                # Beispiel: hello, echo, Gruppen, Config, Menüs, Task
│   ├── permissions/            # Regeln verwalten
│   ├── downloader/             # Git-Repos als Cog-Quellen
│   ├── modlog/ mod/ mutes/ warnings/ cleanup/ filter/ automod/ retrigger/
│       inviteblocklist/ reports/ roletools/ alias/ admin/ extendedmodlog/   # Phase 2
│   ├── economy/ levelup/ badges/ general/ customcom/ welcome/ suggestions/ tickets/
│       trivia/ (inkl. lists/*.json) bingo/ conversions/ eventposter/ streams/ image/ instadl/   # Phase 3
│   └── afkchannel/ untis/ animewatch/ dailystats/ birthday/ gameblacklist/ jellyfinmusic/   # Phase 4
└── tests/                      # Vitest: Loader, Config-API, Rechte, Parser, Dispatcher, Phase-2-Cogs
```

Zur Laufzeit legt der Bot in `/data` (Docker-Volume) an:

```
/data/
├── bot.sqlite      # Config, Regeln, Cog-Daten
├── health.json     # für den Healthcheck
├── repos/          # geklonte Git-Repos (Downloader)
├── cogs/           # installierte Cogs (überschreiben mitgelieferte gleichen Namens)
└── cog-libs/       # npm-Abhängigkeiten installierter Cogs
```

---

## Schnellstart mit Docker

### 1. Application und Bot auf deiner Instanz anlegen

1. Auf **https://chat.nebendahl.eu** anmelden.
2. **User Settings → Applications** öffnen und eine neue Application anlegen (z. B. „Red“).
3. In der Application einen **Bot** erstellen bzw. aktivieren und das **Bot-Token kopieren**.
   Das Token hat die Form `{application_id}.{secret}`. Der Teil vor dem Punkt ist die Application-ID.

### 2. Konfigurieren

```bash
git clone <dieses-repo> fluxer-redbot && cd fluxer-redbot
cp .env.example .env
nano .env        # FLUXER_TOKEN und BOT_OWNER_IDS eintragen
```

Deine Fluxer-User-ID bekommst du in Fluxer über „ID kopieren“ (Entwicklermodus) in deinem Profil.
Der Owner der Application wird zusätzlich automatisch als Bot-Owner erkannt.

### 3. Starten

```bash
docker compose up -d --build
docker compose logs -f bot
```

### 4. Bot einladen

Beim Start loggt der Bot den Einladungslink (`"msg":"Einladungslink"`). Du kannst ihn auch selbst bauen:

```
https://chat.nebendahl.eu/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=1099934592214
```

Die Zahl hinter `permissions` fordert die Rechte an, die die geplanten Cogs brauchen (Nachrichten, Embeds,
Reaktionen, Nachrichten verwalten, Rollen verwalten, Kicken, Bannen, Timeout, **Mitglieder verschieben**,
Verbinden/Sprechen, Kanäle verwalten, Audit-Log). Im Chat liefert `!invite` den Link ebenfalls.

### 5. Erste Schritte im Chat

```
!help                         Übersicht aller Befehle nach Kategorie
!set addadminrole @Admins     Admin-Rolle festlegen
!set addmodrole @Moderatoren  Mod-Rolle festlegen
!prefix set ?                 anderes Prefix für diesen Server
!cogs                         geladene und verfügbare Cogs
!hello                        Beispiel-Cog testen
```

---

## Konfiguration (.env)

| Variable | Standard | Bedeutung |
|---|---|---|
| `FLUXER_BASE_URL` | `https://chat.nebendahl.eu` | Basis-URL der Instanz (Web-App, Einladungslinks, Discovery) |
| `FLUXER_API_BASE_URL` | `https://chat.nebendahl.eu/api` | REST-Basis **ohne** Version. Leer = aus der Discovery (`/.well-known/fluxer` → `endpoints.api_public`), sonst `${FLUXER_BASE_URL}/api` |
| `FLUXER_API_VERSION` | `1` | wird als `/v1` angehängt (Fluxer kennt derzeit nur v1) |
| `FLUXER_DISCOVERY` | `true` | Instanz-Discovery beim Start abfragen und loggen |
| `FLUXER_TOKEN` | – | Bot-Token (**Pflicht**) |
| `BOT_PREFIX` | `!` | Standard-Prefix |
| `BOT_OWNER_IDS` | – | Owner-IDs, kommagetrennt |
| `BOT_LOCALE` | `de` | Sprache der Bot-Texte |
| `TZ` | `Europe/Berlin` | Zeitzone (Scheduler, Datumsangaben) |
| `DATA_DIR` | `/data` | Datenverzeichnis |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | Logging |
| `WATCHDOG_SECONDS` | `600` | so lange ohne Gateway, dann Neustart des Prozesses |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | – | streams: Twitch-Livestreams ([dev.twitch.tv/console](https://dev.twitch.tv/console), kostenlos) |
| `YOUTUBE_API_KEY` | – | streams: YouTube-**Livestreams** (neue Videos funktionieren ohne Key per RSS) |
| `IMGUR_CLIENT_ID` / `GIPHY_API_KEY` | – | image: Imgur-Suche bzw. GIFs (Katzen/Hunde/Füchse ohne Key) |
| `INSTAGRAM_COOKIES` | – | instadl: Pfad zu einer Cookie-Datei (Netscape-Format), falls Instagram eine Anmeldung verlangt |
| `UPLOAD_LIMIT_MB` | `25` | instadl: max. Dateigröße für Uploads (**Annahme** zum Limit der Instanz) |
| `YTDLP_PATH` | `yt-dlp` | Pfad zu yt-dlp (im Docker-Image enthalten) |
| `UNTIS_ENCRYPTION_KEY` | – | untis: 32-Byte-Schlüssel (Hex) für die Passwort-Verschlüsselung – `openssl rand -hex 32` |
| `TMDB_API_KEY` | – | animewatch: Serien und Filme (Animes über AniList ohne Key) |
| `JELLYFIN_URL` / `JELLYFIN_API_KEY` / `JELLYFIN_USER_ID` | `https://jellyfin.mrcoolgamer.de` | jellyfinmusic |

**Gateway-URL:** Sie wird nicht geraten, sondern über `GET {API}/v1/gateway/bot` abgefragt und
**unverändert** verwendet (keine Umschreibung von `ws` auf `wss`), wie es die Fluxer-Doku verlangt.

---

## Kernbefehle

Alle Befehle funktionieren mit dem Prefix oder per Erwähnung (`@Bot help`). `<…>` ist Pflicht, `[…]` optional.

| Befehl | Stufe | Beschreibung |
|---|---|---|
| `help [befehl\|cog]` | Jeder | Hilfe nach Kategorien, pro Cog oder pro Befehl (Blättern mit ⬅️ ➡️) |
| `ping` | Jeder | Antwortzeit |
| `info` | Jeder | Version, Instanz, Server, Cogs, Laufzeit, Owner |
| `uptime` | Jeder | Laufzeit |
| `prefix` / `prefix set <p…>` / `prefix reset` | Jeder / Admin | Prefix anzeigen/ändern (pro Server) |
| `load <cogs…>` / `unload <cogs…>` / `reload <cogs…>` | Owner | Cogs zur Laufzeit (ent)laden |
| `cogs` | Owner | „N geladen: …“ / „N nicht geladen: …“ |
| `set name <name>` | Owner | Benutzername des Bots |
| `set avatar [url]` (oder Bild anhängen) | Owner | Avatar (`entfernen` löscht ihn) |
| `set status <online\|abwesend\|dnd\|unsichtbar> [text]` | Owner | Status und Status-Text |
| `set globalprefix <p…\|reset>` | Owner | globale Prefixe |
| `set locale <de>` / `set serverlocale <de\|reset>` | Owner / Admin | Sprache |
| `set embeds <an\|aus>` / `set serverembeds <an\|aus>` | Owner / Admin | Embeds oder reiner Text |
| `set addadminrole/removeadminrole <rolle>` | Serverbesitzer/Administrator | Admin-Rollen |
| `set addmodrole/removemodrole <rolle>` | Serverbesitzer/Administrator | Mod-Rollen |
| `set showsettings` | Jeder | aktuelle Einstellungen |
| `owner` / `owner add <user>` / `owner remove <user>` | Owner | Owner verwalten (mit Bestätigung per ✅) |
| `shutdown` / `restart` | Owner | herunterfahren / neu starten |
| `invite` | Owner | Einladungslink |
| `traceback [n]` | Owner | letzte unerwartete Fehler per DM |
| `tasks` / `tasks run <besitzer> <name>` | Owner | geplante Tasks anzeigen / sofort ausführen |
| `autoimmune` / `add` / `remove` / `check` | Admin | Ausnahmen von Automod, Filter und Einladungssperre (Mods+ sind immer ausgenommen) |

**Fehlermeldungen** sind lesbar: falsche Argumente zeigen die Verwendung, fehlende Rechte nennen die
nötige Stufe bzw. Berechtigung, Cooldowns die Wartezeit. Unerwartete Fehler bekommen eine Fehler-ID,
die der Owner mit `traceback` nachsehen kann. Ein Fehler in einem Cog bringt den Bot nie zum Absturz.

---

## Berechtigungen

**Stufen** (wie bei Red): `Jeder` < `Moderator` < `Administrator` < `Serverbesitzer` < `Bot-Owner`.

- **Moderator:** hat eine Mod-Rolle (`set addmodrole`) oder ist Admin
- **Administrator:** hat eine Admin-Rolle (`set addadminrole`) oder die Server-Berechtigung *Administrator*
- Befehle können zusätzlich **alternative Rechte** angeben (wie Reds `mod_or_permissions`). Ein Kick-Befehl
  ist dann z. B. für Mods *oder* für alle mit „Mitglieder kicken“ erlaubt.

**Regeln** (Cog `permissions`, wie Reds Permissions-Cog): erlauben oder verbieten pro Befehl oder Cog,
für Benutzer, Rollen, Kanäle (auch Kategorien und Voice-Kanäle) oder einen ganzen Server, global (Owner)
oder pro Server (Serverbesitzer/Administrator).

```
!perms addserverrule deny #allgemein trivia            Trivia in #allgemein verbieten
!perms addserverrule allow @Helfer cmd:cleanup messages einem Mod-Befehl Helfern freigeben
!perms setdefaultserverrule deny economy               Economy standardmäßig aus …
!perms addserverrule allow #casino economy             … außer in #casino
!perms addglobalrule deny 200000000000000004 cog:general  global für einen User sperren
!perms list | !perms canrun @user <befehl> | !perms explain
```

Auswertung, wobei die erste passende Regel gewinnt:
1. Bot-Owner dürfen immer.
2. Globale Regeln vor Server-Regeln.
3. Befehl vor übergeordneter Gruppe vor Cog.
4. Benutzer → Voice-Kanal → Kanal → Kategorie → Rollen (höchste zuerst) → Server.
5. Standard-Regeln (`setdefault…rule`) zuletzt.

Eine **Verbieten**-Regel sperrt immer. Eine **Erlauben**-Regel hebt die Stufe auf, außer bei Befehlen
für Serverbesitzer und Bot-Owner.

Das Ziel ist ein Cog-Name oder ein Befehl; mit `cog:`/`cmd:` lässt es sich eindeutig machen
(z. B. `cmd:set name`). „Wer“ ist eine Erwähnung, ID oder ein Name, oder `server` für alle.

---

## Downloader: Cogs aus Git-Repos

```
!repo add meine https://forgejo.example.de/ich/fluxer-cogs.git        öffentliches Repo
!repo add privat https://user:TOKEN@forgejo.example.de/ich/cogs.git main   privates Repo (Token in der URL)
!repo list | !repo info meine | !repo update [namen…] | !repo delete meine
!cog list meine                Cogs im Repo
!cog install meine afkchannel  installieren → danach !load afkchannel
!cog update [cogs…]            aktualisieren (geladene werden automatisch neu geladen)
!cog uninstall afkchannel      entladen und entfernen
!cog list                      installierte Cogs
```

- Ein Repo enthält Cog-Ordner (mit `manifest.json`) im Wurzelverzeichnis **oder** unter `cogs/`.
- Erlaubt sind `https://`, `ssh://` und `git@…`-URLs. Zugangsdaten werden in allen Ausgaben maskiert,
  und eine Nachricht mit Token in der URL löscht der Bot.
- `npmDependencies` aus dem Manifest werden nach `/data/cog-libs` installiert.
- Installierte Cogs liegen in `/data/cogs` und **überschreiben** mitgelieferte Cogs gleichen Namens.
- Wie bei Red gibt es eine einmalige Warnung: Fremde Cogs sind Code mit vollen Rechten.
- Für SSH-URLs braucht der Container einen Schlüssel (z. B. `~/.ssh` als Volume für User `node` einbinden).
  Mit HTTPS und Token ist das einfacher.

---

## Cogs entwickeln

Ein Cog ist ein Ordner `cogs/<name>/` (oder in einem Git-Repo) mit:

```
cogs/meincog/
├── manifest.json
├── index.ts          # export default defineCog({...})
├── locales/de.json   # optional: Texte des Cogs
└── lib/…             # beliebige weitere Module (werden mitgebündelt)
```

### manifest.json

```json
{
  "name": "meincog",
  "version": "1.0.0",
  "author": "Dein Name",
  "description": "Was der Cog macht.",
  "displayName": "Mein Cog",
  "dependencies": ["andererCog"],
  "npmDependencies": { "date-fns": "^4.1.0" },
  "endUserData": "Speichert pro User …",
  "hidden": false
}
```

`name` muss dem Ordnernamen entsprechen (Kleinbuchstaben, Ziffern, `-`, `_`). `dependencies` sind andere
Cogs: Sie werden beim Laden automatisch mitgeladen, und Entladen verweigert der Bot, solange abhängige
Cogs geladen sind.

### index.ts

```ts
import { defineCog, OptionType, embed, UserError, type ResolvedUser } from '@bot/sdk';

export default defineCog({
  setup(cog) {
    // Config: eigener Namensraum, Scopes global/guild/channel/role/member/user/custom
    cog.config.registerGuild({ channel: null as string | null, enabled: false });
    cog.config.registerMember({ points: 0 });

    // Befehl im Slash-Command-Format
    cog.command({
      name: 'punkte',
      description: 'Zeigt Punkte.',           // oder ein i18n-Schlüssel
      aliases: ['points'],
      options: [{ name: 'user', description: 'Wessen Punkte?', type: OptionType.User }],
      cooldown: { rate: 2, per: 10, bucket: 'user' },
      permissions: { level: 'everyone' },     // 'mod' | 'admin' | 'guildowner' | 'owner', member: [...], bot: [...]
      guildOnly: true,
      run: async (ctx) => {
        const target = ctx.arg<ResolvedUser | undefined>('user') ?? { id: ctx.author.id };
        const points = cog.config.member(ctx.guildId!, target.id).get<number>('points');
        await ctx.reply(ctx.t('points', { user: `<@${target.id}>`, points }));
      },
    });

    // Gruppe mit Unterbefehlen
    cog.group({
      name: 'meincog',
      description: 'Einstellungen',
      permissions: { level: 'admin', member: ['ManageGuild'] },
      subcommands: [
        { name: 'an', description: 'Aktivieren', run: (ctx) => { cog.config.guild(ctx.guildId!).set('enabled', true); return ctx.tick(); } },
      ],
    });

    // Gateway-Events (Fluxer/Discord-Namen) und Bot-Events
    cog.on('GUILD_MEMBER_ADD', (member) => { /* … */ });
    cog.on('VOICE_STATE_UPDATE', (state, previous) => { /* previous = alter Voice-State */ });
    cog.on('commandNotFound', (event) => { /* für alias/customcom */ });
    cog.on('levelUp', (e) => { /* eigene Events anderer Cogs */ });
    cog.emit('meinEvent', { guildId });       // eigenes Event senden (camelCase)

    // Zeitgesteuert (Europe/Berlin)
    cog.schedule({ name: 'täglich', cron: '0 9 * * *', run: async () => { /* … */ } });
    cog.schedule({ name: 'check', every: '15m', run: async (signal) => { /* … */ } });

    // eigene Tabellen (Präfix cog_<name>_)
    cog.migrate([`CREATE TABLE IF NOT EXISTS ${cog.tablePrefix}log (id INTEGER PRIMARY KEY, text TEXT)`]);

    cog.onReady(() => cog.log.info('verbunden'));
    cog.onUnload(() => { /* Ressourcen freigeben */ });
  },
  teardown(cog) { /* optional */ },
});
```

**Argumenttypen:** `String`, `Integer`, `Number`, `Boolean` (ja/nein/an/aus), `User` (Erwähnung, ID oder Name),
`Role`, `Channel` (optional `channel_types`), `Mentionable`, `Attachment` (aus den Anhängen der Nachricht).
Dazu kommen `choices`, `min_value`/`max_value`, `min_length`/`max_length`, `default` und die Prefix-Erweiterungen
`rest: true` (nimmt den Rest der Eingabe) und `variadic: true` (Array). Anführungszeichen gruppieren: `"zwei Wörter"` bzw. `„zwei Wörter“`.

**Kontext (`ctx`):** `reply`, `send` (lange Texte werden automatisch geteilt), `sendEmbed` (mit Text-Fallback,
wenn Embeds aus sind oder das Recht fehlt), `react`, `tick`, `dm`, `typing`, `paginate(pages)` (⬅️ ➡️ ⏹️),
`confirm(frage)` (✅/❌), `choose(seite, anzahl)` (1️⃣–🔟), `sendHelp()`, `t(key, vars)`; dazu `ctx.bot`, `ctx.guild`,
`ctx.member`, `ctx.author`, `ctx.message`.

**Fehler:** `throw new UserError('Text')` zeigt den Text an. `throw new CommandError('i18n.key', {…})` zeigt den übersetzten Text.

**Texte (i18n):** `cog.t('key', vars)` sucht in `locales/<sprache>.json` des Cogs, danach im Kern. Platzhalter `{name}`,
Plural `{ "one": "…", "other": "…" }` mit `count`. Befehls- und Optionsbeschreibungen werden gettext-artig übersetzt:
Der deutsche Text ist selbst der Schlüssel. Für Englisch reicht später eine `en.json` mit `{ "Zeigt Punkte.": "Shows points." }`.

**Hot-Reload:** `!reload meincog` bündelt den Cog (inklusive aller Untermodule) neu mit esbuild und lädt ihn
ohne Neustart. Config-Daten bleiben erhalten. Listener, Tasks und Befehle der alten Version entfernt der
Loader automatisch.

**Slash-Commands später:** `bot.registry.exportApplicationCommands()` erzeugt aus den Definitionen das
native JSON (inkl. `default_member_permissions`, `dm_permission`).

Vorlage: [`cogs/example/index.ts`](cogs/example/index.ts).

---

## Cogs im Detail

Alle Cogs lädst du mit `!load <name>`. Abhängigkeiten (z. B. `modlog`) lädt der Bot automatisch mit.
Mit `!help <cog>` siehst du alle Befehle und mit `!help <befehl>` die Details.
**Annahme** heißt: So funktioniert es bei Red oder es liegt nahe, eine 1:1-Vorlage gibt es nicht.

### Querschnitt

- **Immunität:** Filter, Automod, Einladungssperre und ReTrigger (Löschen/Kick/Bann) ignorieren Mods,
  Admins, den Serverbesitzer und Einträge aus `!autoimmune add @user|@rolle`.
- **Hierarchie:** Moderationsbefehle verweigern Aktionen gegen Mitglieder mit gleicher oder höherer
  Rolle (abschaltbar mit `!modset hierarchy aus`), gegen den Serverbesitzer und gegen den Bot. Liegt die
  Rolle des Bots zu niedrig, sagt er das.
- **Fälle:** Alle Moderationsaktionen (auch automatische) legen über `modlog` einen Fall an.
- **Cog-Schnittstellen:** Cogs nutzen einander über `cog.expose()` und `bot.cogApi('name')`, z. B.
  `warnings` → `mutes`, `automod` → `warnings`.

### example · permissions · downloader (Phase 1)

Siehe [Berechtigungen](#berechtigungen) und [Downloader](#downloader-cogs-aus-git-repos). `example` ist die Vorlage für eigene Cogs.

### modlog

Fälle (Cases) mit fortlaufender Nummer pro Server, wie bei Red.

| Befehl | Stufe | |
|---|---|---|
| `modlogset channel [#kanal]` | Admin | Log-Kanal (ohne Angabe: Posten aus, Fälle werden weiter gespeichert) |
| `modlogset cases` / `modlogset toggle <aktion>` | Admin | welche Aktionen geloggt werden (`filterhit`, `inviteblock`, `rename` sind standardmäßig aus) |
| `modlogset resetcases` | Serverbesitzer | alle Fälle löschen |
| `case <nr>` · `casesfor <user>` · `listcases <user>` | Mod | Fälle ansehen (ausführlich bzw. kompakt) |
| `reason [nr] <grund>` | Mod | Grund nachtragen; ohne Nummer gilt dein letzter Fall. Fremde Fälle nur Admins |

### mod

| Befehl | Stufe (alternativ Recht) | |
|---|---|---|
| `kick <user> [grund]` | Mod (Kicken) | |
| `ban <user\|id> [tage 0–7] [grund]` | Mod (Bannen) | auch per ID (Fall-Typ `hackban`) |
| `tempban <user> <dauer> [grund]` | Mod (Bannen) | wird automatisch aufgehoben (Prüfung jede Minute) |
| `softban <user> [grund]` | Mod (Bannen) | Bann + Entbannung: entfernt die Nachrichten des letzten Tages |
| `unban <id> [grund]` | Mod (Bannen) | |
| `timeout <user> <dauer> [grund]` / `untimeout` | Mod (Moderieren) | max. 28 Tage (**Annahme**, wie bei Discord) |
| `rename <user> [nick]` | Mod (Nicknames) | ohne Nick: zurücksetzen |
| `slowmode [intervall]` | Mod (Kanäle) | 0–6 h |
| `voicekick <user>` | Mod (Verschieben) | trennt vom Sprachkanal |
| `userinfo [user]` | Jeder | Rollen, Beitritt, Timeout, Anzahl Fälle (nur für Mods) |
| `modset show\|dm\|deletedays\|hierarchy` | Admin | DM vor der Aktion, Standard-Löschtage, Hierarchie |

Dauern: `30s`, `10m`, `2h`, `3d`, `1w`, kombinierbar wie `1h30m`.

### mutes

- `mute <user> [dauer] [grund]`: mit Mute-Rolle (`muteset role`), sonst per **Timeout**. Ohne Dauer gilt die
  Standarddauer (`muteset defaulttime`). Ohne Standarddauer bleibt eine Rollen-Stummschaltung dauerhaft, ein
  Timeout dauert 28 Tage.
- `unmute`, `channelmute <user> [dauer] [grund]`, `channelunmute`: Kanal-Stummschaltung per Mitglieds-Overwrite
  (verbietet Schreiben, Reagieren, Sprechen). Vorherige Overwrites werden wiederhergestellt.
- `activemutes`: Liste. `muteset makerole [name]` erstellt eine Mute-Rolle und sperrt sie in allen Kanälen.
- Ablauf: Eine Prüfung alle 30 s hebt auf und legt einen Fall `unmute` an. **Sticky:** Wer stummgeschaltet
  geht und zurückkommt, bekommt die Mute-Rolle wieder.

### warnings

- `warn <user> [punkte] <grund | vordefinierter grund>`: Standard 1 Punkt.
- `warnings [user]` (eigene für alle, fremde nur Mods), `unwarn <user> <id>`.
- `warnreason add <name> <punkte> <beschreibung>` / `delete` / `list`.
- `warnaction add <name> <punkte> <kick|ban|timeout|mute> [dauer]`: Wird eine Schwelle durch eine Verwarnung
  **neu** erreicht, führt der Bot die höchste davon aus.
- `warningset dm|customreasons|showmoderator|warnchannel`.

### cleanup

`cleanup messages <n>` · `user <user> <n>` · `text <n> <text>` · `bot <n>` (Bot-Nachrichten und Befehle) ·
`self <n>` · `duplicates <n>` · `after <nachricht>` · `before <nachricht> <n>` · `between <von> <bis>`

- Höchstens 1000 Nachrichten, ab 100 fragt der Bot per ✅ nach.
- Gelöscht wird per Bulk-Delete in 100er-Blöcken. Nachrichten älter als 14 Tage oder ein abgelehnter
  Bulk-Delete werden einzeln gelöscht (**Annahme:** 14-Tage-Grenze wie bei Discord).
- Nachrichtenverweis = Link `…/channels/<server>/<kanal>/<nachricht>`, `<kanal>-<nachricht>` oder die ID.

### filter

- `filter add|delete <begriffe…>`: Ganze Wörter, ohne Groß/Klein. `*` ist Platzhalter (`spam*`), Phrasen in
  Anführungszeichen. Die Befehlsnachricht wird gelöscht.
- `filter list` (per DM), `filter clear`, `filter channel add|delete|list|clear` für einzelne Kanäle.
- Bearbeitete Nachrichten werden ebenfalls geprüft.
- `filter names an` ersetzt anstößige Nicknames durch `filter defaultname`.
- `filter ban <anzahl> <zeitraum>`: automatischer Bann nach wiederholten Treffern.

### automod

`automod` zeigt den Status, `automod toggle an` schaltet ein.

| Regel | Standard | Parameter |
|---|---|---|
| `spam` | an, Timeout 10 min | `max` Nachrichten in `seconds` (6 in 8 s) |
| `mentions` | an, Timeout 1 h | `max` Erwähnungen pro Nachricht (6) |
| `duplicates` | an, löschen | `max` gleiche Nachrichten in `seconds` (4 in 60 s) |
| `caps` | aus | `percent` (75) ab `minLength` Buchstaben (15) |
| `links` | aus | Erlaubnisliste: `automod allowlink youtube.com` |
| `emojis` | aus | `max` (12) |
| `newlines` | aus | `max` Zeilen (25) |

- Aktionen: `delete`, `warn` (über `warnings`), `timeout`, `kick`, `ban`. Löschen passiert immer.
- Befehle: `automod rule <regel> an|aus`, `automod action <regel> <aktion> [dauer]`,
  `automod set <regel> <parameter> <wert>`, `automod ignore #kanal|@rolle`, `automod log #kanal`, `automod reset`.
- **Annahme:** Reds Kern hat kein „automod“. Die Regeln oben sind die übliche Auswahl.

### retrigger

- `retrigger text|dm|react|delete|command|kick|ban <name> <regex> [antwort]`
- Regex mit Leerzeichen in Anführungszeichen, `(?i)` am Anfang = ohne Groß/Klein.
- Platzhalter: `{user}`, `{user.name}`, `{channel}`, `{server}`, `{count}`, `{1}`… (Gruppen).
- `retrigger list|info|remove|toggle|cooldown|ignore`.
- Nur für Admins: JavaScript-Regex lassen sich nicht abbrechen, deshalb gibt es ein Längenlimit und eine
  Prüfung auf verschachtelte Quantoren.
- Nachrichten mit Befehls-Prefix lösen nur Lösch-Trigger aus (verhindert Schleifen).

### inviteblocklist

- `inviteblock toggle an`, `inviteblock mode alle|liste`, `inviteblock allow add|remove <code|server-id>`,
  `inviteblock block add|remove …`, `inviteblock ownserver an|aus`, `inviteblock notify an|aus`, `inviteblock check <link>`.
- Erkennt **(Annahme)** `fluxer.gg/<code>`, `<deine-instanz>/invite/<code>`, `web.fluxer.app/invite/<code>` sowie
  Discord-Einladungen.
- Den Zielserver ermittelt der Bot über `GET /invites/<code>` (1 h zwischengespeichert).

### reports

- `report [@user] <text>`: im Server (die Nachricht wird gelöscht, die Bestätigung kommt per DM) oder **per DM an
  den Bot**. Bei mehreren gemeinsamen Servern fragt der Bot per 1️⃣–🔟, welcher gemeint ist.
- Im Team-Kanal (`reportset output #kanal`) erscheint ein Embed mit ✅. Ein Mod reagiert damit, die Meldung gilt
  als erledigt, und die meldende Person bekommt optional eine DM.
- `reports` listet offene Meldungen.
- **Annahme:** Reds „report interact“ (Live-Chat mit der meldenden Person) ist nicht umgesetzt.

### roletools

- **Reaktionsrollen (statt Buttons):** `roletools reaction add <nachricht> <emoji> <@rolle>`, `remove`, `list`.
  Reaktion entfernen = Rolle entfernen.
- `roletools auto <rolle> an`: beim Beitritt vergeben. `roletools sticky <rolle> an`: beim erneuten Beitritt
  wiederherstellen.
- `roletools exclusive add <rolle> <andere…>` (schließen sich gegenseitig aus), `roletools required add <rolle> <rollen…>`
  (eine davon wird benötigt), `roletools info <rolle>`.

### alias

- `alias add <name> <befehl …>`: Mod oder „Server verwalten“. `alias delete|list|show`.
- `alias global add|delete|list` ist nur für den Owner.
- Zusätzliche Argumente werden angehängt (`!b @user Spam` → `!ban @user Spam`). Aliase auf Aliase gehen bis Tiefe 5.

### admin

- `addrole <rolle> [user]`, `removerole <rolle> [user]`, `editrole color <rolle> <#hex|name>`, `editrole name <rolle> <name>`
- `selfrole <rolle>` / `selfrole remove <rolle>` / `selfrole list`. Festlegen mit `selfroleset add|remove <rollen…>`.
- `announce <text>` (Owner) geht an alle Server mit `announceset channel #kanal`. `announceset ignore` schaltet das für einen Server ab.
- `serverlock` (Owner): Neue Server verlässt der Bot sofort.

### extendedmodlog

- `extmodlog channel #kanal`, dann `extmodlog toggle alle an` (oder einzelne Events).
- `extmodlog eventchannel <event> #kanal` setzt einen eigenen Kanal pro Event. `extmodlog ignore #kanal|kategorie`
  und `extmodlog bots an|aus` steuern Ausnahmen.
- Events: gelöschte/bearbeitete Nachrichten (auch Bulk), Beitritte/Austritte, Bann/Entbannung,
  Nickname- und Rollenänderungen, Rollen erstellt/gelöscht/geändert, Kanäle erstellt/gelöscht/geändert,
  Sprachkanal betreten/verlassen/gewechselt, Einladungen, benutzte Befehle.
- **Hinweis:** Fluxer schickt beim Löschen nur die ID. Den Inhalt kennt der Bot nur aus seinem
  Nachrichten-Cache (die letzten 5000 Nachrichten seit dem Start).

### economy

Bank wie bei Red: pro Server, oder mit `bank setglobal an` (Owner) eine gemeinsame Bank für alle Server.

- `balance [user]`, `transfer <user> <betrag>`, `payday` (Standard: 120 Taler alle 5 Minuten),
  `slot <einsatz>` (Spielautomat), `leaderboard [anzahl]`.
- `bank set <user> <500|+100|-50>`, `bank reset` (Admin).
- `economyset paydayamount|paydaytime|slotmin|slotmax|slottime|registeramount|currency|bankname`.
- Andere Cogs (trivia, bingo) zahlen Belohnungen über die Bank aus.

### levelup

- XP für Nachrichten: zufällig 15–25 XP, höchstens einmal pro 60 s. Befehle zählen nicht.
- **Sprach-XP:** jede Minute 5 XP für alle, die mit mindestens einer weiteren Person im Sprachkanal sind und weder stumm
  noch taub geschaltet sind. Der AFK-Kanal zählt nicht.
- Level-Formel wie bei MEE6: Von Level *l* auf *l+1* braucht man 5·l² + 50·l + 100 XP.
- `rank [user]`, `levels` (Rangliste).
- `levelset` zeigt die Einstellungen, außerdem `enabled`, `xp <min> <max>`, `cooldown`, `voicexp an|aus`, `voicerate <xp>`,
  `announce hier|kanal|dm|aus [#kanal]` und `message <text>` mit `{user}`, `{level}`, `{server}`.
- `levelset ignore #kanal|@rolle`, `role add <level> <@rolle>` (`stackroles aus` = nur die höchste behalten),
  `setlevel`, `addxp`, `reset`.

### badges

- `badgeset create <name> <emoji> <beschreibung>`, `delete`, `give <user> <abzeichen>`, `take`.
- `badgeset autolevel <abzeichen> <level>` vergibt das Abzeichen automatisch beim Level-Aufstieg (braucht levelup).
- `badges [user]` zeigt die Abzeichen eines Mitglieds. `profile [user]` zeigt Level, Rang, Guthaben, Beitrittsdatum und
  Abzeichen.
- **Annahme:** Ein 1:1-Vorbild gibt es nicht. Profile werden als Embed dargestellt, nicht als Bild.

### general

`8ball <frage?>`, `choose <a> <b> …`, `flip [user]`, `roll [max]`, `rps <stein|papier|schere>`, `lmgtfy <suche>`,
`stopwatch`, `serverinfo`, `urban <begriff>` (Urban Dictionary, englisch).

### customcom

- `customcom create simple <name> <antwort>`.
- `customcom create random <name> <a | b | c>`: Antworten mit `|` trennen. **Annahme:** Bei Red läuft das interaktiv.
- `customcom edit|delete|cooldown <name> <sekunden> [user|channel|server]|list|show|search`.
- Platzhalter: `{author}`, `{author.name}`, `{channel}`, `{channel.name}`, `{server}`, `{0}`…`{9}` (Argumente),
  `{args}` (alle Argumente), `{uses}`.
- Aliase (Cog `alias`) haben bei gleichem Namen Vorrang.

### welcome

- `welcomeset channel #kanal`, `welcomeset toggle an`, `welcomeset event join|leave|ban an|aus`.
- `welcomeset add|remove|list <art> …`: mehrere Texte möglich, der Bot wählt zufällig.
  Platzhalter: `{member}`, `{member.name}`, `{server}`, `{count}`.
- `welcomeset dm <text|aus>` (zusätzliche DM), `welcomeset embed an`, `welcomeset test join`.

### suggestions

- `suggest <text>`: Ein Embed mit Nummer erscheint im Vorschlagskanal, abgestimmt wird mit 👍/👎.
- `suggestion approve|deny <nr> [begründung]` (Mod): Das Embed wird aktualisiert (mit Stimmenzahl), optional in einen
  eigenen Kanal kopiert, und die einreichende Person bekommt eine DM.
- `suggestset channel|approvedchannel|deniedchannel|toggle|anonymous|dm|emojis`.

### tickets

- `ticketset panel #kanal [text]` postet ein Panel. Reaktion mit 🎫 öffnet ein Ticket, alternativ `ticket new [grund]`.
- Jedes Ticket ist ein privater Kanal `ticket-0001`, sichtbar nur für die öffnende Person, die Support-Rollen
  (`ticketset supportrole @rolle`) und den Bot.
- `ticket add|remove <user>`, `ticket close [grund]`: Das Protokoll geht als `.txt` in den Log-Kanal
  (`ticketset log #kanal`), danach wird der Kanal gelöscht.
- `ticketset category|max|message|toggle`, `ticket list`.

### trivia

- `trivia <liste> [weitere …]` startet ein Quiz. Antworten schreibt man einfach in den Kanal.
- Mitgeliefert: `allgemeinwissen`, `geografie`, `wissenschaft` (je 25 Fragen, deutsch).
- Die Antwortprüfung ignoriert Groß/Klein, Satzzeichen und Umlaut-Schreibweisen (ü = ue). Längere Antworten zählen
  auch im Satz („Ich glaube Goethe“).
- Standard: Sieg bei 10 Punkten, 20 s pro Frage, Abbruch nach 3 unbeantworteten Fragen.
- `trivia stop`, `trivia list`, `trivia leaderboard [siege|punkte|spiele]`.
- `triviaset maxscore|timeout|delay|payout|stopafter|reveal`.
- Belohnung wie bei Red: Punkte × payout an den eindeutigen Sieger, bei mindestens 3 Teilnehmenden.
- Eigene Listen: `triviaset upload <name>` mit einer JSON-Datei als Anhang (Owner).
  Format: `{"name": "…", "questions": [{"question": "…", "answers": ["…", "…"]}]}`.

### bingo

- `bingoset tiles Ereignis 1; Ereignis 2; …` (mindestens 24 Felder), `bingoset add|remove|free|name|reward`.
- `bingo` zeigt deine zufällige 5×5-Karte; die Mitte ist frei.
- `bingo mark <B3 | 13 | Textteil>` / `bingo unmark …`. Eine volle Reihe, Spalte oder Diagonale ergibt **BINGO** (mit
  optionaler Belohnung).
- `bingo winners`, `bingo new` (Mod) startet eine neue Runde.
- **Annahme:** angelehnt an TrustyJAIDs Bingo. Die Karte erscheint als Emoji-Raster mit Legende statt als Bild.

### conversions

- `convert <menge> <von> [in] <nach>` für Einheiten: Länge, Gewicht, Volumen, Fläche, Geschwindigkeit, Daten, Zeit,
  Temperatur.
- Währungen über EZB-Referenzkurse (frankfurter.app, ohne Key, 1 h zwischengespeichert). Krypto über CoinGecko (ohne Key).
- `crypto <coin> [währung]`, `units`.
- **Abweichung:** Aktienkurse sind nicht enthalten, weil es keine stabile kostenlose Quelle gibt.

### eventposter

- `event create <wann> | <Titel> [| Beschreibung]`.
  Zeitangaben: `morgen 20:00`, `Samstag 19:30`, `24.12. 18:00`, `2026-12-24 18:00`, `in 2h`, `20:00`.
- Anmeldung per Reaktion: ✅ dabei, ❔ vielleicht. Optionales Teilnehmerlimit; wer zu viel ist, bekommt eine DM.
- Erinnerung an alle Angemeldeten X Minuten vor dem Start (Standard 15). Nach 6 h gilt das Event als vorbei.
- `event list|cancel <id>|edit <id> <wann> | <titel> | …`.
- `eventset channel|pingrole|max|reminder|creators alle|mods`.

### streams

- `streamalert twitch <name> [#kanal]`: Livestream-Meldung mit Titel, Spiel, Zuschauern und Vorschaubild.
  Geprüft wird alle 2 min. Braucht `TWITCH_CLIENT_ID/SECRET`.
- `streamalert youtube <UC…-ID | @handle | URL> [#kanal]`: **neue Videos** über den RSS-Feed, ohne Key, alle 5 min.
  Mit `YOUTUBE_API_KEY` meldet der Bot auch **YouTube-Livestreams**; dann wird alle 15 min geprüft, weil jede Abfrage
  100 Einheiten des Tageskontingents kostet.
- `streamalert remove|list`, `streamset mention @rolle|everyone|aus`, `streamset message|videomessage <text>`
  (`{name}`, `{title}`, `{url}`, `{game}`), `streamset check`.
- **Annahme:** @Handles werden über die Kanalseite aufgelöst. Funktioniert das nicht, die UC-ID verwenden.

### image

`imgur <suche>` (Imgur, NSFW nur in NSFW-Kanälen), `gif <suche>` (GIPHY), `cat`, `dog`, `fox` (ohne Key).
**Abweichung:** Reds Image-Cog hat keine Tierbilder, dafür Subreddit-Suche, die hier fehlt.

### instadl

- `insta <link>` lädt einen Post, ein Reel oder ein Karussell (bis 10 Dateien) herunter und postet die Medien im Kanal.
- `instaset auto [#kanal]`: Instagram-Links in diesem Kanal werden automatisch heruntergeladen.
  `instaset deleteoriginal an` löscht danach die Ursprungsnachricht.
- Technik: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (im Docker-Image enthalten, beim Neubauen immer die neueste Version).
- **Wichtig:** Instagram blockiert anonyme Downloads häufig. Dann eine Cookie-Datei eines (Zweit-)Kontos exportieren
  (Netscape-Format, z. B. per Browser-Erweiterung „Get cookies.txt“) und so einbinden: Datei nach `./secrets/`,
  im compose `./secrets:/secrets:ro` aktivieren, dann `INSTAGRAM_COOKIES=/secrets/instagram-cookies.txt`.
- Dateien über `UPLOAD_LIMIT_MB` werden übersprungen. Höchstens 2 Downloads laufen gleichzeitig.

### afkchannel

- `afkchannel set #sprachkanal` setzt den AFK-Kanal und aktiviert die Funktion. Ohne eigene Angabe gilt der in den
  Server-Einstellungen hinterlegte AFK-Kanal.
- Wer im Sprachkanal **taub geschaltet** ist (self_deaf), wird nach der Wartezeit (`afkchannel delay <sekunden>`,
  Standard 60 s, 0 = sofort) verschoben. Wer vorher wieder hört, bleibt.
- `afkchannel moveback an`: Beim Ent-Taubschalten im AFK-Kanal geht es zurück in den vorherigen Kanal. Der wird
  gespeichert und übersteht auch einen Neustart.
- `afkchannel ignore @rolle|@user|#kanal` (umschalten), `afkchannel toggle an|aus`, `afkchannel` zeigt die
  Einstellungen.
- Der Bot braucht das Recht **Mitglieder verschieben**. `afkchannel set` prüft das und warnt.

### untis

- **Zugangsdaten nur per DM:** `untis login <server> "<schule>" <benutzer> <passwort>`.
  Server = Adresse aus WebUntis, z. B. `neilo.webuntis.com`. Der Bot testet den Login, bevor er speichert.
- Jede `untis login`-Nachricht in einem Server-Kanal löscht der Bot sofort und warnt öffentlich und per DM, auch
  ohne gültiges Prefix (z. B. `/untis login …`).
- Passwörter liegen **AES-256-GCM-verschlüsselt** in der Datenbank. Der Schlüssel kommt aus `UNTIS_ENCRYPTION_KEY`;
  ohne Schlüssel speichert der Bot nichts.
- `untis heute|morgen|woche`: im Server kommt der Plan per DM. `untis status`, `untis check`.
  `untis forget` meldet ab und löscht alles.
- **Benachrichtigungen:** `untis notify dm|kanal|aus`. `kanal` im gewünschten Server-Kanal ausführen.
- Ein Hintergrund-Check (Standard alle 15 Minuten, `untisset interval <min>` als Owner) vergleicht die nächsten
  7 Tage mit dem letzten Stand und meldet:
  ❌ Entfall, 🔁 Vertretung/Sonderstunde, 👤 Lehrerwechsel, 🚪 Raumänderung, ⏰ geänderte Zeiten.
- Jede Änderung wird nur einmal gemeldet. Die Session wird pro Abruf geöffnet und wieder geschlossen.
- Nach 3 fehlgeschlagenen Logins pausieren die Benachrichtigungen, und die Person bekommt eine DM.
- **Annahmen:**
  - Lehrer- und Raumwechsel erkennt der Bot an WebUntis' `orgname` (ursprünglicher Wert) oder am Vergleich mit dem
    letzten Stand.
  - Konten ohne eigenen Stundenplan bekommen den Klassenplan.
  - Gegen einen echten WebUntis-Server ungetestet (aus der Entwicklungsumgebung nicht erreichbar).

### animewatch

- `watch add [anime|serie|film] <titel>` sucht Animes über AniList (ohne Key) und Serien/Filme über TMDB (mit
  `TMDB_API_KEY`). Auswahl per 1️⃣–5️⃣.
- `watch status <eintrag> schaue|fertig|geplant|pausiert|abgebrochen`.
- `watch progress <eintrag> [+n|folge|S2E5]`: ohne Angabe +1 Folge. Bei der letzten Folge setzt der Bot automatisch
  „abgeschlossen“.
- `watch rate <eintrag> <1–10>`, `watch list [status] [@user]`, `watch remove`, `watch upcoming`,
  `watch notify dm|kanal|aus`. `<eintrag>` ist die Nummer aus `watch list` oder ein Teil des Titels.
- Der Release-Check läuft alle 30 Minuten für Titel mit Status schaue, geplant oder pausiert:
  - Anime: neue Folge laut AniList-Ausstrahlungsplan.
  - Serie: neue Folge bzw. neue Staffel laut TMDB.
  - Film: Kinostart bzw. digitaler Start in Deutschland laut TMDB.
- Gemeldet wird jeweils einmal. Beim ersten Abruf merkt sich der Bot nur den Stand und meldet nichts.

### dailystats

- **Erfasst nur Zähler, nie Inhalte:**
  - Nachrichten pro Mitglied, Kanal und Stunde
  - Sprachzeit pro Mitglied und Kanal (ohne AFK-Kanal)
  - genutzte Emojis (auch Reaktionen)
  - Beitritte und Austritte
- Bots und Bot-Befehle zählen nicht. Daten älter als 400 Tage werden gelöscht.
- `statsset channel #kanal`, dann automatisch:
  - **Tagesrückblick** (`statsset daily 22:00`)
  - **Wrapped** jede Woche (`statsset weekly Sonntag 18:00`): Top-Mitglieder, Top-Kanäle, Voice-Champions,
    Lieblings-Emojis, aktivste Tageszeit, Vergleich zur Vorwoche
  - **Jahresrückblick** am 31.12. (`statsset yearly an`)
- **Awards:** 🗣️ Dauerredner, 🎙️ Voice-Champion, 🦉 Nachteule (0–5 Uhr), 🐓 Frühaufsteher (5–9 Uhr),
  🧭 Kanal-Hopper, 😂 Emoji-Fan.
- `wrapped [woche|monat|jahr|heute] [@user]` zeigt die persönlichen Stats. `stats today|week|year` sind Vorschauen.
- **Datenschutz:** `stats optout` / `stats optin`. `stats delete` löscht deine Zähler auf allen Servern.
  `statsset reset` (Serverbesitzer) löscht alles auf dem Server.

### birthday

- `birthday set 24.12.` oder `24.12.2000` (das Jahr sieht nur die Person selbst), `birthday remove`,
  `birthday show [@user]`, `birthday list`.
- `bdset channel #kanal`, `bdset time 09:00`, `bdset message <text>` (`{user}`, `{age}`, `{server}`).
- `bdset role @rolle`: Die Rolle gibt es für **24 Stunden**; das Entfernen übersteht auch Neustarts.
- `bdset reminder an` weist am Vortag auf morgige Geburtstage hin. `bdset test` löst den Glückwunsch sofort aus.
- 29. Februar: In Nicht-Schaltjahren wird am 28. gefeiert.

### gameblacklist

- `gameblacklist add <spiel>` (exakter Name; `*` am Ende = „beginnt mit“), `remove`, `toggle an`,
  `timeout <dauer>` (Standard 10 min), `ignore @rolle`, `dm an|aus`, `log #kanal`.
- Mods und Admins sind ausgenommen.
- ⚠️ **Hängt davon ab, ob Fluxer Spiel-Aktivitäten in `PRESENCE_UPDATE` liefert.** Die Fluxer-Typen kennen das Feld
  `activities`, aber ob die Fluxer-Apps laufende Spiele melden, ist unbekannt.
- `gameblacklist status` zeigt, wie viele Presence-Updates und Spiel-Aktivitäten seit dem Start ankamen. Bleibt das
  bei 0, kann die Blacklist nicht greifen. Beim Aktivieren weist der Bot darauf hin.

### jellyfinmusic

- **Bot-Audio ist experimentell:** Fluxer nutzt LiveKit. Der Bot meldet sich per Gateway (op 4) im Sprachkanal an,
  erhält einen LiveKit-Grant (`VOICE_SERVER_UPDATE`) und veröffentlicht einen Opus-Audiotrack über `@fluxerjs/voice`.
  Das ist mit Fake-Verbindungen getestet und lädt im Container, **wurde aber noch nie gegen eine echte Instanz
  ausgeführt**.
- `play <suche | YouTube-Link | Playlist-Link>`. YouTube kommt über yt-dlp direkt als WebM/Opus (kein ffmpeg nötig).
- `play jf: <suche>` oder `jellyfin <suche>` spielt vom Jellyfin-Server (Titel, Alben, Playlists; Auswahl 1️⃣–5️⃣).
  Jellyfin transkodiert serverseitig nach WebM/Opus (`/Audio/{id}/universal`, **Annahme:** Jellyfin 10.8+).
- `search <suche>` (YouTube mit Auswahl), `queue`, `np`, `skip`, `remove <nr>`, `volume [0–200]`,
  `stop` (= verlassen).
- Ist der Bot allein im Kanal oder die Warteschlange leer, verlässt er ihn nach `musicset idle` Sekunden
  (Standard 120).
- `musicset status` prüft yt-dlp, Jellyfin und die Sprachverbindung.
- Phase 5 (`audio`) baut darauf auf: Wiederholen, Mischen und Playlists sind im Player schon vorbereitet.

## Cog-Status

Legende: ✅ fertig · ⏳ geplant · ⚠️ fertig, aber von Fluxer-Fähigkeiten abhängig bzw. experimentell

| Cog | Phase | Status | Hinweis |
|---|---|---|---|
| **core** (Kern) | 1 | ✅ | load/unload/reload/cogs/help/ping/info/uptime/prefix/set/shutdown/restart/owner |
| **example** | 1 | ✅ | Beispiel/Vorlage (hello, echo, Menüs, Task) |
| **permissions** | 1 (vorgezogen aus 2) | ✅ | Regeln pro Befehl/Cog |
| **downloader** | 1 (Erweiterungen in 5) | ✅ | Repos, install/update/uninstall |
| admin | 2 | ✅ |  |
| alias | 2 | ✅ |  |
| mod (kick/ban/unban/timeout) | 2 | ✅ | tempban, softban, rename, slowmode, voicekick, userinfo |
| modlog | 2 | ✅ |  |
| extendedmodlog | 2 | ✅ |  |
| mutes | 2 | ✅ | Rolle oder Timeout, Kanal-Mutes |
| warnings | 2 | ✅ | Punkte + Eskalation |
| automod | 2 | ✅ | 7 Regeln |
| filter | 2 | ✅ |  |
| retrigger | 2 | ✅ |  |
| inviteblocklist | 2 | ✅ |  |
| cleanup | 2 | ✅ |  |
| reports | 2 | ✅ |  |
| roletools | 2 | ✅ | Reaktionsrollen statt Buttons |
| general | 3 | ✅ | 8ball, roll, flip, rps, serverinfo, urban … |
| customcom | 3 | ✅ | Platzhalter, zufällige Antworten |
| welcome | 3 | ✅ | join/leave/ban, DM |
| suggestions | 3 | ✅ | 👍/👎, annehmen/ablehnen |
| tickets | 3 | ✅ | Reaktion statt Button zum Öffnen, Protokoll |
| levelup | 3 | ✅ | Nachrichten- und Sprach-XP, Level-Rollen |
| badges | 3 | ✅ | manuell oder ab Level, Profil |
| economy | 3 | ✅ | Bank, Zahltag, Automat |
| trivia | 3 | ✅ | 3 deutsche Listen, eigene Listen |
| bingo | 3 | ✅ | 5×5-Karten |
| conversions | 3 | ✅ | Einheiten, EZB-Kurse, Krypto |
| eventposter | 3 | ✅ | Anmeldung per Reaktion, Erinnerung |
| streams | 3 | ✅ | Twitch (Key), YouTube-Videos ohne Key |
| image | 3 | ✅ | Imgur/GIPHY (Key), Tiere ohne Key |
| instadl | 3 | ✅ | per yt-dlp, ggf. Cookies nötig |
| afkchannel | 4 | ✅ | Verzögerung, Ausnahmen, Zurückverschieben |
| untis | 4 | ✅ | AES-256-GCM, Änderungs-Check (gegen echtes WebUntis ungetestet) |
| animewatch | 4 | ✅ | AniList ohne Key, TMDB mit Key |
| dailystats | 4 | ✅ | nur Zähler, Wrapped mit Awards, Opt-out |
| birthday | 4 | ✅ | Rolle 24 h, Vorab-Erinnerung |
| gameblacklist | 4 | ⚠️ | umgesetzt; greift nur, wenn Fluxer Spiel-Aktivitäten liefert (`gameblacklist status`) |
| jellyfinmusic | 4 | ⚠️ | umgesetzt über LiveKit (@fluxerjs/voice), gegen echte Instanz ungetestet |
| audio | 5 | ⚠️ | wie jellyfinmusic |

Zusammen sind das die 39 Cogs deines Red-Bots (15 + 15 + 7 + audio + downloader) plus `core` und `example`.

---

## Fluxer: Einschränkungen und Annahmen

Grundlage: docs.fluxer.app (laut Suche), die Typen und Quellen von `@fluxerjs/*` 3.x und ein Ende-zu-Ende-Test
gegen einen nachgebauten Fluxer-Server. **Wichtig:** `chat.nebendahl.eu` und `docs.fluxer.app` waren aus der
Entwicklungsumgebung **nicht erreichbar**. Was nicht gegen deine Instanz geprüft werden konnte, ist unten
als *Annahme* markiert.

| Thema | Stand | Umsetzung |
|---|---|---|
| Slash-Commands, Buttons, Modals, Interactions | gibt es auf Fluxer noch nicht | Prefix-Befehle + Reaktionen. Definitionen im Slash-Format, Export vorbereitet |
| Gateway-Intents | gibt es auf Fluxer nicht (IDENTIFY ohne Intents) | – |
| Gateway-URL | aus `GET /v1/gateway/bot`, unverändert verwenden | ✅ so umgesetzt und getestet |
| API-Version | nur v1 | `FLUXER_API_VERSION=1` |
| API-Pfad auf deiner Instanz | **Annahme:** `https://chat.nebendahl.eu/api` (Self-Hosting liefert die API unter `/api`); bevorzugt wird der Wert aus `/.well-known/fluxer` | Discovery beim Start, Abweichung wird geloggt |
| Bot-Token / Auth | `Authorization: Bot {application_id}.{secret}` | ✅ |
| Voice-State-Updates empfangen | ja (`VOICE_STATE_UPDATE` mit `self_deaf`, `self_mute`, `channel_id`) | Cache + Event mit vorherigem Zustand |
| Mitglieder verschieben | **Annahme:** `PATCH /guilds/{id}/members/{user}` mit `channel_id` (wie Discord; @fluxerjs unterstützt das Feld) | `platform.moveMember()`; Recht „Mitglieder verschieben“ |
| Timeout | `communication_disabled_until` (+ `timeout_reason`) beim Member-PATCH | `platform.timeoutMember()` |
| Audio senden | Fluxer nutzt **LiveKit**: Voice-State (op 4, mit `mutation_id`) → `VOICE_SERVER_UPDATE` (endpoint, token, connection_id) bzw. `VOICE_STATE_ACK` bei Ablehnung → LiveKit-Raum | **Experimentell umgesetzt** (`src/platform/voiceService.ts` + `LiveKitRtcConnection` aus `@fluxerjs/voice`): Handshake getestet, natives LiveKit-Modul lädt im Container. Gegen eine echte Instanz **ungetestet**; Fehler kommen als klare Meldung |
| Presence/Aktivitäten | `PRESENCE_UPDATE` hat ein `activities`-Feld; **ob Fluxer-Clients laufende Spiele melden, ist unklar** (Fluxer setzt auf Custom Status) | gameblacklist ist umgesetzt und zeigt mit `gameblacklist status`, ob Aktivitäten ankommen |
| Embeds | Discord-kompatibles Format (`rich`) | mit Text-Fallback |
| Nachrichtenlänge | **Annahme:** 2000 Zeichen | lange Texte werden automatisch geteilt |
| Audit-Log-Grund | **Annahme:** Header `X-Audit-Log-Reason` | – |
| Gelöschte Nachrichten | `MESSAGE_DELETE` enthält nur IDs | eigener Nachrichten-Cache (5000) für Lösch-/Bearbeitungs-Logs |
| Bulk-Delete | `POST /channels/{id}/messages/bulk-delete`; **Annahme:** 14-Tage-Grenze | ältere Nachrichten einzeln, Fallback bei Fehler |
| Rollen/Overwrites | Discord-kompatible Routen (`/guilds/{id}/roles`, `/channels/{id}/permissions/{id}`) | – |
| Einladungslinks | **Annahme:** `fluxer.gg/<code>` und `<instanz>/invite/<code>` | inviteblocklist |
| Nachrichtenlinks | **Annahme:** `<instanz>/channels/<server>/<kanal>/<nachricht>` | Reaktionsrollen, cleanup |
| Kanäle anlegen/löschen | `POST /guilds/{id}/channels` mit `permission_overwrites`, `DELETE /channels/{id}` | tickets |
| Datei-Uploads | Multipart wie bei Discord (`files[n]` + `payload_json`, über @fluxerjs/rest); **Annahme:** Limit 25 MB | tickets (Protokoll), instadl |
| Reaktionszahlen | `GET /channels/{id}/messages/{id}` liefert `reactions[].count` (**Annahme**) | suggestions (Stimmen) |
| Einladungslink | **Annahme:** `{BASE_URL}/oauth2/authorize?client_id=…&scope=bot&permissions=…` | `!invite`, Start-Log |
| Rate-Limits | 429 + `retry_after` | `@fluxerjs/rest` wartet und wiederholt automatisch (Buckets pro Route, 3 Retries) |
| Reconnect | RESUME mit Session-ID/Sequenz, sonst neues IDENTIFY | `@fluxerjs/ws`; getestet. Dazu Watchdog (Neustart nach `WATCHDOG_SECONDS`) |
| Sharding | `/gateway/bot` meldet `shards: 1` | ein Shard |

**Library-Wahl:** Verwendet werden `@fluxerjs/rest` und `@fluxerjs/ws`, die Transport-Pakete aus dem
`@fluxerjs/core`-Projekt. Sie liefern Rate-Limit-Handling, Gateway-Abruf, Heartbeat, RESUME und Reconnect.
Auf die Objektschicht von `@fluxerjs/core` habe ich verzichtet: Der Bot arbeitet mit den rohen,
Discord-ähnlichen Payloads und einem eigenen schlanken Cache. Das hält die Cog-API stabil und testbar.

---

## Entwicklung und Tests

```bash
npm install
cp .env.example .env          # DATA_DIR=./data für lokal
npm run dev                   # tsx watch
npm test                      # Vitest
npm run typecheck
npm run build && npm start
```

Die Tests (`tests/`) decken ab:
- **Loader:** Discovery, Laden, Hot-Reload inklusive Untermodulen, Entladen räumt Befehle/Listener/Tasks ab, Abhängigkeiten, Zyklen, Rollback bei Fehlern/Konflikten, Syntaxfehler, Fehler-Isolation, Wiederherstellen nach Neustart
- **Config-API:** alle Scopes, Defaults, Namensräume, `update`, `allMembers`, Persistenz
- **Berechtigungen:** Stufen, alternative Rechte, Regel-Reihenfolge, globale vs. Server-Regeln, Defaults, Kanal-Overwrites
- **Befehle:** Tokenizer/Parser, Registry, Slash-Export, Cooldowns, Dispatcher Ende-zu-Ende, Embed-Fallback, i18n
- **Phase 2:** alle 14 Cogs laden konfliktfrei, Kick/Ban/Tempban/Timeout inkl. Fälle und Hierarchie, Mutes (Timeout/Rolle/Kanal, Ablauf),
  Verwarnungs-Eskalation, Filter, Automod, Einladungssperre, Cleanup (Bulk-Delete), ReTrigger, Alias, Meldungen mit ✅,
  Reaktions- und Auto-Rollen, addrole, Lösch-Log mit Cache-Inhalt, Hilfe mit allen Cogs
- **Phase 3:** Level-Formel, Automat, Platzhalter, Trivia-Antwortprüfung und Fragenlisten, Bingo-Logik, Einheiten,
  deutsche Zeitangaben, YouTube-RSS, Instagram-Links, Ticket-Protokoll; Ende-zu-Ende: Zahltag/Überweisung,
  eigene Befehle mit Alias-Vorrang, Begrüßung, Vorschlag annehmen, Ticket öffnen/schließen mit Upload, XP → Level →
  Auto-Abzeichen, komplette Trivia-Runde, Bingo, Event-Anmeldung per Reaktion, Instagram-Download (mit Fake-yt-dlp)
- **Phase 4:** AFK-Logik, Geburtstage (inkl. 29.2.), Spielerkennung, Emoji-Zählung, AES-256-GCM (inkl. Manipulation),
  Stundenplan-Änderungserkennung, Fortschritts-Parser, Jellyfin-URL; **Voice-Handshake** (op 4 → VOICE_SERVER_UPDATE →
  LiveKit, Ablehnung, Timeout); Ende-zu-Ende: AFK-Verschieben und Zurückverschieben, Geburtstagspost mit Rolle,
  Blacklist-Timeout, Statistik/Wrapped/Opt-out, Schutz von Zugangsdaten in Kanälen, Watchlist mit gefälschter AniList
  und Folgen-Benachrichtigung, Musik-Wiedergabe mit Fake-LiveKit; alle ≥ 39 Cogs gemeinsam ohne Konflikte

---

## Betrieb

- **Logs:** `docker compose logs -f bot` (JSON, z. B. mit `| jq` lesen; `LOG_PRETTY=true` für Klartext)
- **Backup:** Volume `bot-data` sichern, z. B. `docker run --rm -v fluxer-redbot_bot-data:/d -v $PWD:/b alpine tar czf /b/backup.tgz -C /d .`
- **Update:** `git pull && docker compose up -d --build`
- **`!restart`** beendet den Prozess mit Code 26 und Docker startet ihn neu. Wegen `restart: unless-stopped`
  startet auch **`!shutdown`** neu. Dauerhaft stoppen mit `docker compose stop`.
- **Healthcheck:** gesund, solange der Bot verbunden ist oder seit weniger als 5 Minuten getrennt (Auto-Reconnect läuft).
- **Watchdog:** nach `WATCHDOG_SECONDS` ohne Gateway beendet sich der Prozess, Docker startet neu.
- **Kein eingehender Port** nötig, der Bot verbindet sich nur ausgehend.
