import type { CSSProperties } from 'react';
import type { PluginAppearance, PluginVisualEffect, UserPlugin } from '../../types';

export const pluginEffects: PluginVisualEffect[] = ['aurora', 'plasma', 'liquid', 'prism', 'solar', 'nebula', 'chrome', 'pulse'];

const hash = (value: string) => [...value].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 2166136261);

export const appearanceForPlugin = (plugin: Pick<UserPlugin, 'id' | 'definition'>): PluginAppearance => {
  if (plugin.definition.appearance) return plugin.definition.appearance;
  const seed = hash(plugin.id);
  return { effect: pluginEffects[seed % pluginEffects.length], hue: seed % 360, seed: (seed % 999_999) + 1 };
};

export function PluginGlyph({ appearance, compact = false }: { appearance: PluginAppearance; compact?: boolean }) {
  const style = {
    '--plugin-hue': appearance.hue,
    '--plugin-seed': appearance.seed % 11,
  } as CSSProperties;
  return <span className={`dash-plugin-glyph effect-${appearance.effect} ${compact ? 'compact' : ''}`} style={style} aria-hidden="true">
    <i className="dash-plugin-ring ring-one" />
    <i className="dash-plugin-ring ring-two" />
    <i className="dash-plugin-ring ring-three" />
    <i className="dash-plugin-ring ring-four" />
    <i className="dash-plugin-material" />
  </span>;
}
