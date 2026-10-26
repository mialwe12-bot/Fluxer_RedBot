import fs from 'node:fs';
import path from 'node:path';

/**
 * Einfache i18n-Struktur: pro Namensraum (Kern oder Cog) und Sprache ein JSON-Bundle.
 * Schlüssel sind verschachtelt und werden per Punkt adressiert: t('core.help.title').
 * Platzhalter: {name}. Plural: { "one": "…", "other": "…" } + Variable `count`.
 * Fehlt ein Text in der gewünschten Sprache, wird Deutsch verwendet, danach der Schlüssel selbst.
 *
 * Befehls- und Optionsbeschreibungen werden gettext-artig übersetzt: Der deutsche Text ist der
 * Schlüssel. Eine englische Datei kann also einfach { "Lädt Cogs.": "Loads cogs." } enthalten.
 */
export type Messages = { [key: string]: string | Messages };
export type Vars = Record<string, string | number | bigint | boolean | null | undefined>;
export type Translator = (key: string, vars?: Vars) => string;

export const FALLBACK_LOCALE = 'de';

export class I18n {
  private readonly bundles = new Map<string, Map<string, Messages>>();

  constructor(public defaultLocale: string = FALLBACK_LOCALE) {}

  addBundle(namespace: string, locale: string, messages: Messages): void {
    let ns = this.bundles.get(namespace);
    if (!ns) this.bundles.set(namespace, (ns = new Map()));
    ns.set(locale, messages);
  }

  /** Lädt alle `<locale>.json` aus einem Verzeichnis für einen Namensraum. */
  loadDirectory(namespace: string, dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const locale = path.basename(file, '.json');
      const messages = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Messages;
      this.addBundle(namespace, locale, messages);
    }
  }

  removeNamespace(namespace: string): void {
    this.bundles.delete(namespace);
  }

  locales(): string[] {
    const set = new Set<string>();
    for (const ns of this.bundles.values()) for (const l of ns.keys()) set.add(l);
    return [...set].sort();
  }

  private lookup(namespace: string, locale: string, key: string): string | Messages | undefined {
    const bundle = this.bundles.get(namespace)?.get(locale);
    if (!bundle) return undefined;
    // gettext-Stil: der (deutsche) Originaltext selbst ist der Schlüssel, z. B. { "Lädt Cogs.": "Loads cogs." }
    if (typeof bundle[key] === 'string') return bundle[key];
    let node: string | Messages | undefined = bundle;
    for (const part of key.split('.')) {
      if (node === undefined || typeof node === 'string') return undefined;
      node = node[part];
    }
    return node;
  }

  /** Übersetzt `key` im Namensraum; `namespaces` werden der Reihe nach durchsucht. */
  t(namespaces: string | string[], key: string, vars: Vars = {}, locale?: string): string {
    const list = Array.isArray(namespaces) ? namespaces : [namespaces];
    const tries = [...new Set([locale ?? this.defaultLocale, this.defaultLocale, FALLBACK_LOCALE])];
    for (const loc of tries) {
      for (const ns of list) {
        const value = this.lookup(ns, loc, key);
        if (value === undefined) continue;
        return interpolate(pickPlural(value, vars, loc), vars);
      }
    }
    return key;
  }

  translator(namespaces: string | string[], locale?: () => string | undefined): Translator {
    return (key, vars) => this.t(namespaces, key, vars, locale?.());
  }
}

function pickPlural(value: string | Messages, vars: Vars, locale: string): string {
  if (typeof value === 'string') return value;
  const count = Number(vars.count ?? 0);
  if (count === 0 && typeof value.zero === 'string') return value.zero;
  const category = new Intl.PluralRules(locale).select(count);
  const chosen = value[category] ?? value.other;
  return typeof chosen === 'string' ? chosen : JSON.stringify(value);
}

function interpolate(text: string, vars: Vars): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? match : String(v);
  });
}
