export type UiTheme = 'obsidian' | 'graphite' | 'ivory' | 'cobalt';

export type UiThemeDefinition = {
  id: UiTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
  roleColors: Record<string, string>;
  scene: {
    background: string;
    fog: string;
    grid: string;
    gridSecondary: string;
    ambient: string;
    keyLight: string;
    signal: string;
    warm: string;
    error: string;
    idle: string;
  };
};

export const UI_THEMES: UiThemeDefinition[] = [
  {
    id: 'obsidian',
    label: '曜石绿',
    description: '近黑 · 薄荷绿 · 柔金',
    swatches: ['#0b1110', '#8bd3b1', '#d3b57a'],
    roleColors: {
      orchestrator: '#d3b57a',
      planner: '#b8d3c6',
      researcher: '#8dbfa9',
      analyst: '#c4a978',
      builder: '#8bd3b1',
      reviewer: '#c48f8d',
      synthesizer: '#c1c9c3',
    },
    scene: {
      background: '#07100d',
      fog: '#07100d',
      grid: '#254139',
      gridSecondary: '#13251f',
      ambient: '#b6d0c3',
      keyLight: '#e0eee7',
      signal: '#84d8b1',
      warm: '#d3b57a',
      error: '#d8787d',
      idle: '#254038',
    },
  },
  {
    id: 'graphite',
    label: '黑金',
    description: '墨黑 · 香槟金 · 暖白',
    swatches: ['#121110', '#d8b36a', '#eee0bf'],
    roleColors: {
      orchestrator: '#e1bf79',
      planner: '#eee0bf',
      researcher: '#c9b98f',
      analyst: '#d4a85e',
      builder: '#d8b36a',
      reviewer: '#c99182',
      synthesizer: '#d7d0c3',
    },
    scene: {
      background: '#0d0d0c',
      fog: '#0d0d0c',
      grid: '#4a3d27',
      gridSecondary: '#282319',
      ambient: '#d6c9ae',
      keyLight: '#fff7e7',
      signal: '#d8b36a',
      warm: '#eee0bf',
      error: '#d58b8b',
      idle: '#4a4030',
    },
  },
  {
    id: 'ivory',
    label: '深灰绿',
    description: '深灰 · 冷银 · 薄荷绿',
    swatches: ['#15191d', '#68747c', '#95e4ba'],
    roleColors: {
      orchestrator: '#95e4ba',
      planner: '#c0cdd5',
      researcher: '#85c6ff',
      analyst: '#f1bd72',
      builder: '#c7afe2',
      reviewer: '#f293a2',
      synthesizer: '#aeb9c0',
    },
    scene: {
      background: '#15191d',
      fog: '#101316',
      grid: '#48545c',
      gridSecondary: '#293138',
      ambient: '#aebcc4',
      keyLight: '#f1f4f6',
      signal: '#95e4ba',
      warm: '#f1bd72',
      error: '#f293a2',
      idle: '#3a444b',
    },
  },
  {
    id: 'cobalt',
    label: '石墨银蓝',
    description: '深石墨 · 银蓝 · 冷白',
    swatches: ['#0e141b', '#8daec7', '#d4dde4'],
    roleColors: {
      orchestrator: '#d4dde4',
      planner: '#bdcfda',
      researcher: '#8eafc6',
      analyst: '#b7a37e',
      builder: '#86b9d4',
      reviewer: '#c38d8d',
      synthesizer: '#c4c7c4',
    },
    scene: {
      background: '#0b121a',
      fog: '#0b121a',
      grid: '#30485a',
      gridSecondary: '#1a2b38',
      ambient: '#bfced7',
      keyLight: '#e5f0f6',
      signal: '#8daec7',
      warm: '#d4dde4',
      error: '#d4868b',
      idle: '#2c414f',
    },
  },
];

export const DEFAULT_UI_THEME: UiTheme = 'obsidian';

export const getUiTheme = (id: UiTheme) => UI_THEMES.find((theme) => theme.id === id) ?? UI_THEMES[0]!;

export const loadUiTheme = (storageKey: string): UiTheme => {
  try {
    const value = localStorage.getItem(storageKey);
    return UI_THEMES.some((theme) => theme.id === value) ? value as UiTheme : DEFAULT_UI_THEME;
  } catch {
    return DEFAULT_UI_THEME;
  }
};
