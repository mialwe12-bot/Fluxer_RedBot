# fluxer-redbot

Ein modularer Bot für die Chat-Plattform **Fluxer**, gebaut nach dem Vorbild von
[Red-DiscordBot](https://github.com/Cog-Creators/Red-DiscordBot): ein schlanker Kern, dazu
**Cogs** (Plugins), die sich zur Laufzeit laden, entladen und neu laden lassen, ohne Neustart.

- Läuft gegen eine **selbst gehostete Fluxer-Instanz** (hier: `https://chat.nebendahl.eu`). Alles kommt aus der `.env`, nichts ist hartcodiert.
- Node.js 22, TypeScript (ESM), SQLite (`better-sqlite3`) mit einer Red-ähnlichen Config-API
- Prefix-Befehle (Standard `!`, pro Server änderbar, Erwähnung des Bots geht immer) und Reaktionen statt Buttons
- Befehle intern im Slash-Command-Format, damit sich native Slash-Commands später ergänzen lassen
- Docker (multi-stage, non-root), Healthcheck, Watchdog, Auto-Reconnect, Zeitzone Europe/Berlin

> **Stand:** Phase 1 (Kern) und Phase 2 (Server-Verwaltung und Moderation) sind fertig. Die übrigen Cogs folgen in Phase 3–5, siehe [Cog-Status](#cog-status).

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
│   │   └── voice.ts            # Voice-Fähigkeiten und Audio-Stub
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
│   └── modlog/ mod/ mutes/ warnings/ cleanup/ filter/ automod/ retrigger/
│       inviteblocklist/ reports/ roletools/ alias/ admin/ extendedmodlog/   # Phase 2
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

## Cog-Status

Legende: ✅ fertig · ⏳ geplant · ⚠️ geplant, aber von Fluxer-Fähigkeiten abhängig (ggf. Stub)

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
| general | 3 | ⏳ | |
| customcom | 3 | ⏳ | |
| welcome | 3 | ⏳ | |
| suggestions | 3 | ⏳ | |
| tickets | 3 | ⏳ | Reaktion statt Button zum Öffnen |
| levelup | 3 | ⏳ | |
| badges | 3 | ⏳ | |
| economy | 3 | ⏳ | |
| trivia | 3 | ⏳ | |
| bingo | 3 | ⏳ | |
| conversions | 3 | ⏳ | |
| eventposter | 3 | ⏳ | |
| streams | 3 | ⏳ | Twitch/YouTube-API-Keys nötig |
| image | 3 | ⏳ | |
| instadl | 3 | ⏳ | Instagram ändert häufig die API |
| afkchannel | 4 | ⏳ | Voice-State-Events ✅, Verschieben angenommen ✅ |
| untis | 4 | ⏳ | AES-256-GCM, Zugangsdaten nur per DM |
| animewatch | 4 | ⏳ | AniList (ohne Key) + TMDB (Key) |
| dailystats | 4 | ⏳ | nur Zähler, Opt-out |
| birthday | 4 | ⏳ | |
| gameblacklist | 4 | ⚠️ | braucht Spiel-Aktivitäten in PRESENCE_UPDATE (unverifiziert) |
| jellyfinmusic | 4 | ⚠️ | braucht Bot-Audio (LiveKit), siehe unten |
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
| Audio senden | Fluxer nutzt **LiveKit**: Voice-State (op 4) → `VOICE_SERVER_UPDATE`-Grant (600 s) → LiveKit-Protokoll. Es gibt `@fluxerjs/voice`, ob es mit deiner Instanz funktioniert, ist **ungetestet** | Im Kern ein Stub (`VoiceUnsupportedError` mit klarer Meldung). Wird in Phase 4/5 geprüft |
| Presence/Aktivitäten | `PRESENCE_UPDATE` hat ein `activities`-Feld; **ob Fluxer-Clients laufende Spiele melden, ist unklar** (Fluxer setzt auf Custom Status) | Presences werden gecacht; gameblacklist ggf. als Stub |
| Embeds | Discord-kompatibles Format (`rich`) | mit Text-Fallback |
| Nachrichtenlänge | **Annahme:** 2000 Zeichen | lange Texte werden automatisch geteilt |
| Audit-Log-Grund | **Annahme:** Header `X-Audit-Log-Reason` | – |
| Gelöschte Nachrichten | `MESSAGE_DELETE` enthält nur IDs | eigener Nachrichten-Cache (5000) für Lösch-/Bearbeitungs-Logs |
| Bulk-Delete | `POST /channels/{id}/messages/bulk-delete`; **Annahme:** 14-Tage-Grenze | ältere Nachrichten einzeln, Fallback bei Fehler |
| Rollen/Overwrites | Discord-kompatible Routen (`/guilds/{id}/roles`, `/channels/{id}/permissions/{id}`) | – |
| Einladungslinks | **Annahme:** `fluxer.gg/<code>` und `<instanz>/invite/<code>` | inviteblocklist |
| Nachrichtenlinks | **Annahme:** `<instanz>/channels/<server>/<kanal>/<nachricht>` | Reaktionsrollen, cleanup |
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
