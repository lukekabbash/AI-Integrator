export const THEME_STORAGE_KEY = "ai-integrator.appearance.v1";
export const THEME_FILE_VERSION = 1 as const;

export type ThemeAppearance = "dark" | "light";
export type ThemeId =
  | "graphite"
  | "ash"
  | "midnight"
  | "slate"
  | "ocean"
  | "forest"
  | "sand"
  | "ember"
  | "rosewood"
  | "arctic"
  | "paper"
  | "high-contrast";
export type ThemePresetId = ThemeId;

export const THEME_COLOR_TOKENS = [
  "surface.canvas",
  "surface.rail",
  "surface.panel",
  "surface.layer1",
  "surface.layer2",
  "surface.elevated",
  "surface.overlay",
  "text.primary",
  "text.secondary",
  "text.muted",
  "text.inverse",
  "border.subtle",
  "border.strong",
  "focus.ring",
  "selection.active",
  "selection.text",
  "accent.primary",
  "accent.hover",
  "accent.pressed",
  "accent.subtle",
  "accent.text",
  "status.success",
  "status.warning",
  "status.danger",
  "status.info",
  "status.successSurface",
  "status.warningSurface",
  "status.dangerSurface",
  "status.infoSurface",
  "diff.added",
  "diff.addedStrong",
  "diff.addedText",
  "diff.removed",
  "diff.removedStrong",
  "diff.removedText",
  "diff.context",
  "syntax.keyword",
  "syntax.string",
  "syntax.type",
  "syntax.function",
  "syntax.variable",
  "syntax.number",
  "syntax.comment",
  "terminal.ansi0",
  "terminal.ansi1",
  "terminal.ansi2",
  "terminal.ansi3",
  "terminal.ansi4",
  "terminal.ansi5",
  "terminal.ansi6",
  "terminal.ansi7",
  "terminal.ansi8",
  "terminal.ansi9",
  "terminal.ansi10",
  "terminal.ansi11",
  "terminal.ansi12",
  "terminal.ansi13",
  "terminal.ansi14",
  "terminal.ansi15",
  "chrome.background",
  "chrome.foreground",
] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export type ThemeColors = Readonly<Record<ThemeColorToken, string>>;

export interface ThemePreset {
  readonly id: ThemeId;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly description: string;
  readonly colors: ThemeColors;
}

type ThemeSourcePalette = Readonly<{
  surface: readonly [string, string, string, string, string, string, string];
  text: readonly [string, string, string, string];
  border: readonly [string, string];
  interaction: readonly [string, string, string];
  accent: readonly [string, string, string, string, string];
  status: readonly [string, string, string, string];
  statusSurface: readonly [string, string, string, string];
  diff: readonly [string, string, string, string, string, string, string];
  syntax: readonly [string, string, string, string, string, string, string];
  ansi: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  chrome: readonly [string, string];
}>;

function themeColors(palette: ThemeSourcePalette): ThemeColors {
  const [canvas, rail, panel, layer1, layer2, elevated, overlay] = palette.surface;
  const [primary, secondary, muted, inverse] = palette.text;
  const [subtle, strong] = palette.border;
  const [focus, selected, selectedText] = palette.interaction;
  const [accent, accentHover, accentPressed, accentSubtle, accentText] = palette.accent;
  const [success, warning, danger, info] = palette.status;
  const [successSurface, warningSurface, dangerSurface, infoSurface] = palette.statusSurface;
  const [added, addedStrong, addedText, removed, removedStrong, removedText, context] =
    palette.diff;
  const [keyword, string, type, fn, variable, number, comment] = palette.syntax;

  return {
    "surface.canvas": canvas,
    "surface.rail": rail,
    "surface.panel": panel,
    "surface.layer1": layer1,
    "surface.layer2": layer2,
    "surface.elevated": elevated,
    "surface.overlay": overlay,
    "text.primary": primary,
    "text.secondary": secondary,
    "text.muted": muted,
    "text.inverse": inverse,
    "border.subtle": subtle,
    "border.strong": strong,
    "focus.ring": focus,
    "selection.active": selected,
    "selection.text": selectedText,
    "accent.primary": accent,
    "accent.hover": accentHover,
    "accent.pressed": accentPressed,
    "accent.subtle": accentSubtle,
    "accent.text": accentText,
    "status.success": success,
    "status.warning": warning,
    "status.danger": danger,
    "status.info": info,
    "status.successSurface": successSurface,
    "status.warningSurface": warningSurface,
    "status.dangerSurface": dangerSurface,
    "status.infoSurface": infoSurface,
    "diff.added": added,
    "diff.addedStrong": addedStrong,
    "diff.addedText": addedText,
    "diff.removed": removed,
    "diff.removedStrong": removedStrong,
    "diff.removedText": removedText,
    "diff.context": context,
    "syntax.keyword": keyword,
    "syntax.string": string,
    "syntax.type": type,
    "syntax.function": fn,
    "syntax.variable": variable,
    "syntax.number": number,
    "syntax.comment": comment,
    "terminal.ansi0": palette.ansi[0],
    "terminal.ansi1": palette.ansi[1],
    "terminal.ansi2": palette.ansi[2],
    "terminal.ansi3": palette.ansi[3],
    "terminal.ansi4": palette.ansi[4],
    "terminal.ansi5": palette.ansi[5],
    "terminal.ansi6": palette.ansi[6],
    "terminal.ansi7": palette.ansi[7],
    "terminal.ansi8": palette.ansi[8],
    "terminal.ansi9": palette.ansi[9],
    "terminal.ansi10": palette.ansi[10],
    "terminal.ansi11": palette.ansi[11],
    "terminal.ansi12": palette.ansi[12],
    "terminal.ansi13": palette.ansi[13],
    "terminal.ansi14": palette.ansi[14],
    "terminal.ansi15": palette.ansi[15],
    "chrome.background": palette.chrome[0],
    "chrome.foreground": palette.chrome[1],
  };
}

export const THEME_PRESETS = [
  {
    id: "graphite",
    label: "Graphite",
    appearance: "dark",
    description: "Neutral near-black surfaces with a restrained steel-blue signal.",
    colors: themeColors({
      surface: ["#111315", "#16191c", "#1a1d21", "#1e2226", "#23282d", "#292f35", "#090a0bd9"],
      text: ["#f1f4f6", "#bcc4ca", "#7f8a92", "#0d1114"],
      border: ["#2a3035", "#46515a"],
      interaction: ["#7aaed6", "#284861", "#f5f9fc"],
      accent: ["#72a7d1", "#8bb9dc", "#568db8", "#1c3447", "#09131b"],
      status: ["#70b58a", "#d5a956", "#dc7771", "#70a9ce"],
      statusSurface: ["#183125", "#382d18", "#3c2020", "#193247"],
      diff: ["#173124", "#24533a", "#9bd3ae", "#3a1e1e", "#612c2c", "#efaaa4", "#181b1e"],
      syntax: ["#8eb7db", "#a9c98f", "#dbbd77", "#79c6ba", "#d5dbe0", "#d6a47b", "#77838c"],
      ansi: [
        "#171a1d",
        "#d46f6a",
        "#6fb287",
        "#cba14f",
        "#6e9fca",
        "#b58db6",
        "#68aaa8",
        "#c9ced2",
        "#68727a",
        "#ee8b84",
        "#8bcc9f",
        "#e3bd6d",
        "#8ab9df",
        "#c9a4c9",
        "#82c3c0",
        "#f3f5f6",
      ],
      chrome: ["#15181b", "#d9dee2"],
    }),
  },
  {
    id: "ash",
    label: "Ash",
    appearance: "light",
    description: "Soft mineral gray with quiet ink and lake-blue controls.",
    colors: themeColors({
      surface: ["#eef0f1", "#e5e8e9", "#f4f5f5", "#f8f9f9", "#e9eced", "#ffffff", "#2d343ad1"],
      text: ["#20262a", "#4f5b62", "#748087", "#f7f9fa"],
      border: ["#d5dadd", "#aab4ba"],
      interaction: ["#246c94", "#c9e1ee", "#15262f"],
      accent: ["#2f7398", "#245f80", "#1c4c68", "#d7e9f2", "#ffffff"],
      status: ["#347a50", "#956a13", "#ad423e", "#286b94"],
      statusSurface: ["#dcece2", "#f4e9cc", "#f4dedd", "#dceaf2"],
      diff: ["#e0eee4", "#b9ddc4", "#245f3a", "#f4e0df", "#e8bcba", "#923732", "#f5f6f6"],
      syntax: ["#23658e", "#487331", "#8a6116", "#167369", "#33444f", "#a2512b", "#788289"],
      ansi: [
        "#30373b",
        "#ae4540",
        "#33784e",
        "#8e671b",
        "#2f6f99",
        "#855e83",
        "#267674",
        "#d7dbdd",
        "#6b7479",
        "#c95a53",
        "#4e9567",
        "#aa812f",
        "#4c88b0",
        "#a4789f",
        "#46918f",
        "#ffffff",
      ],
      chrome: ["#e5e8e9", "#273036"],
    }),
  },
  {
    id: "midnight",
    label: "Midnight",
    appearance: "dark",
    description: "Inky blue-black depth with clear glacial-blue interaction.",
    colors: themeColors({
      surface: ["#090f18", "#0d1520", "#101a27", "#13202e", "#172534", "#1d2c3c", "#04080edb"],
      text: ["#edf5fb", "#b4c5d3", "#72879a", "#071019"],
      border: ["#1d3042", "#3d5870"],
      interaction: ["#71bce9", "#174c6d", "#f4fbff"],
      accent: ["#5eb4e6", "#7dc6ee", "#3e96c8", "#113b56", "#04131d"],
      status: ["#64bd91", "#e0ad55", "#e07070", "#62b3df"],
      statusSurface: ["#103426", "#3b2b10", "#3d1c22", "#0e3550"],
      diff: ["#103325", "#17543a", "#91d6ad", "#3a1820", "#642635", "#f1a2a5", "#0f1824"],
      syntax: ["#72b7e5", "#8fc78b", "#e3bd72", "#6dd0c3", "#d2deea", "#d9956b", "#60778b"],
      ansi: [
        "#0c131d",
        "#d9676b",
        "#5bb587",
        "#d5a447",
        "#579fd3",
        "#ad83b2",
        "#51aaa9",
        "#bdcbd5",
        "#516476",
        "#f08385",
        "#79cea0",
        "#ebbd65",
        "#78b9e7",
        "#c39bc5",
        "#72c7c4",
        "#edf5fb",
      ],
      chrome: ["#0b121c", "#d7e5ef"],
    }),
  },
  {
    id: "slate",
    label: "Slate",
    appearance: "dark",
    description: "Cool slate layers with precise denim-blue emphasis.",
    colors: themeColors({
      surface: ["#171b20", "#1c2228", "#20272e", "#252d35", "#2a333c", "#303b45", "#0b0e11d9"],
      text: ["#f0f3f5", "#bec7cd", "#828f99", "#11161a"],
      border: ["#303a43", "#52616d"],
      interaction: ["#87b4d2", "#365369", "#f6fafc"],
      accent: ["#79a9ca", "#91bad5", "#5f91b3", "#263f51", "#0e171e"],
      status: ["#75b58e", "#d6aa5c", "#d97873", "#75acce"],
      statusSurface: ["#1d3628", "#3a301d", "#402424", "#1d3749"],
      diff: ["#1c3628", "#2a573c", "#a1d6b3", "#402324", "#683133", "#efaaa6", "#1f252b"],
      syntax: ["#91b8d4", "#9ac38c", "#d5b779", "#7fc5bb", "#d5dde2", "#d39772", "#798792"],
      ansi: [
        "#1a2025",
        "#d16d69",
        "#70ae87",
        "#cda252",
        "#719bc2",
        "#aa8baa",
        "#66a6a5",
        "#c4cbd0",
        "#6b7781",
        "#e98982",
        "#8bc59d",
        "#dfbc72",
        "#8eb2d1",
        "#c19ebe",
        "#82bcba",
        "#f1f4f6",
      ],
      chrome: ["#1b2026", "#dbe1e5"],
    }),
  },
  {
    id: "ocean",
    label: "Ocean",
    appearance: "dark",
    description: "Deep marine surfaces with a crisp cyan-blue current.",
    colors: themeColors({
      surface: ["#071719", "#0a1e21", "#0d2528", "#102d30", "#143639", "#194145", "#020b0cd9"],
      text: ["#eaf7f6", "#aed0ce", "#6e9493", "#061314"],
      border: ["#17373a", "#356064"],
      interaction: ["#57c1c4", "#14595c", "#efffff"],
      accent: ["#49b7bb", "#66c9cc", "#31999d", "#103f42", "#031718"],
      status: ["#63bd8b", "#deb05b", "#df746e", "#4eb4cb"],
      statusSurface: ["#113828", "#3a2f13", "#421e1e", "#0d3a45"],
      diff: ["#103829", "#185b40", "#92d8ac", "#401d20", "#682b30", "#f0a4a0", "#0b2224"],
      syntax: ["#58bdc8", "#87c78e", "#dfbd6c", "#5fd1b5", "#d0e2e1", "#db9568", "#668b8b"],
      ansi: [
        "#091d1f",
        "#d96c68",
        "#5ab684",
        "#d6aa50",
        "#4b9fbd",
        "#a989ae",
        "#45b2ae",
        "#bcd1d0",
        "#547878",
        "#ee8781",
        "#76ce9a",
        "#e9c16c",
        "#68bad2",
        "#c3a0c5",
        "#67cbc5",
        "#eaf7f6",
      ],
      chrome: ["#091c1e", "#d4eae8"],
    }),
  },
  {
    id: "forest",
    label: "Forest",
    appearance: "dark",
    description: "Evergreen charcoal with moss and fern accents.",
    colors: themeColors({
      surface: ["#101713", "#151e19", "#19251e", "#1e2c24", "#24352b", "#2b4034", "#070c08dc"],
      text: ["#eff5f0", "#bdcbbf", "#829486", "#0b120d"],
      border: ["#2a3b30", "#4c6252"],
      interaction: ["#9abc75", "#3b572c", "#f8fff3"],
      accent: ["#8cac68", "#9fbe7d", "#718f51", "#2f4424", "#0d1608"],
      status: ["#76b98a", "#d8ae5d", "#dc766f", "#73aeb9"],
      statusSurface: ["#1b3a27", "#3a3019", "#402120", "#1c363b"],
      diff: ["#193927", "#275a3b", "#9bd4ac", "#3d2020", "#633030", "#eeaaa5", "#17221b"],
      syntax: ["#9abf7c", "#a8c68a", "#d8b875", "#72c1a1", "#d4ddd5", "#d4966f", "#778b7c"],
      ansi: [
        "#121c16",
        "#d36f69",
        "#72b486",
        "#cea54f",
        "#739eaa",
        "#a98ca5",
        "#65a69a",
        "#c6d0c8",
        "#697b6d",
        "#e88982",
        "#8dca9d",
        "#e1bd6c",
        "#8bb7c0",
        "#bea1ba",
        "#80beb0",
        "#eff5f0",
      ],
      chrome: ["#141d17", "#dae5dc"],
    }),
  },
  {
    id: "sand",
    label: "Sand",
    appearance: "light",
    description: "Warm taupe and cream with grounded coastal-blue controls.",
    colors: themeColors({
      surface: ["#eee9df", "#e5ded1", "#f4f0e8", "#f8f5ef", "#e9e2d7", "#fffdf8", "#302b24d1"],
      text: ["#2c2924", "#5d564c", "#81786b", "#fffdf8"],
      border: ["#d8d0c3", "#b1a697"],
      interaction: ["#316f85", "#cce3e8", "#152b32"],
      accent: ["#37778d", "#2a6275", "#214e5e", "#d9eaed", "#ffffff"],
      status: ["#41784d", "#906916", "#a8483f", "#316f8b"],
      statusSurface: ["#e0ebdf", "#f2e7c9", "#f3dfda", "#dce9ed"],
      diff: ["#e1ebdf", "#bed9bd", "#315f39", "#f1dfdb", "#e5bdb6", "#8d3b34", "#f5f1e9"],
      syntax: ["#2b6984", "#557536", "#875f15", "#27736a", "#414a4b", "#9b532c", "#81796d"],
      ansi: [
        "#342f28",
        "#a94b42",
        "#40764c",
        "#8d681d",
        "#366f8d",
        "#7c6579",
        "#327673",
        "#ddd6ca",
        "#71685d",
        "#c05d52",
        "#5c9467",
        "#a68235",
        "#538ba6",
        "#987f93",
        "#52918c",
        "#fffdf8",
      ],
      chrome: ["#e6dfd3", "#312d27"],
    }),
  },
  {
    id: "ember",
    label: "Ember",
    appearance: "dark",
    description: "Warm charcoal with burnished rust interaction.",
    colors: themeColors({
      surface: ["#181311", "#201815", "#281e1a", "#30241f", "#392a24", "#453229", "#0b0706dc"],
      text: ["#f7f0eb", "#d0beb2", "#977f70", "#180d08"],
      border: ["#3b2c25", "#684d3f"],
      interaction: ["#d69262", "#6b3821", "#fff8f3"],
      accent: ["#c97945", "#db8f5d", "#a85f34", "#512c1b", "#1d0d06"],
      status: ["#79b985", "#dfad51", "#dd756e", "#72aebc"],
      statusSurface: ["#203727", "#3e2e13", "#47201e", "#21363b"],
      diff: ["#203727", "#31583b", "#a4d4ae", "#46201e", "#71302d", "#f1aaa3", "#251b17"],
      syntax: ["#d68d5c", "#a4c282", "#dfb66d", "#79bdaa", "#e1d4cc", "#d98c64", "#8f796c"],
      ansi: [
        "#1e1714",
        "#d46e66",
        "#74b181",
        "#d3a34c",
        "#7399b1",
        "#aa888f",
        "#6aa49a",
        "#d3c7bf",
        "#806c60",
        "#ea8880",
        "#90c79a",
        "#e6bb67",
        "#91b1c3",
        "#bf9da2",
        "#86bbb0",
        "#f7f0eb",
      ],
      chrome: ["#1f1714", "#e6d9d0"],
    }),
  },
  {
    id: "rosewood",
    label: "Rosewood",
    appearance: "dark",
    description: "Deep red-brown timber with muted copper focus.",
    colors: themeColors({
      surface: ["#191112", "#211617", "#291c1d", "#322223", "#3b2929", "#473132", "#0c0707dc"],
      text: ["#f7eeee", "#d2bcbc", "#987c7d", "#170b0b"],
      border: ["#3c292a", "#684749"],
      interaction: ["#d49a70", "#663d29", "#fff8f4"],
      accent: ["#c4865c", "#d79b72", "#a66b45", "#503322", "#1a0f08"],
      status: ["#7bb488", "#ddad58", "#df7a72", "#79a9b6"],
      statusSurface: ["#223529", "#3e2d16", "#4a2422", "#22343a"],
      diff: ["#22362a", "#34563e", "#a6d0ae", "#482321", "#743431", "#f2ada6", "#271a1b"],
      syntax: ["#d49a70", "#a3c083", "#ddb776", "#7db8a8", "#dfd0d0", "#da8d68", "#907677"],
      ansi: [
        "#211718",
        "#d7736d",
        "#76ad83",
        "#d1a453",
        "#7897ad",
        "#ad8787",
        "#70a29b",
        "#d4c5c5",
        "#82686a",
        "#ec8d86",
        "#91c598",
        "#e5bd6d",
        "#94afc1",
        "#c09d9c",
        "#8ab8b0",
        "#f7eeee",
      ],
      chrome: ["#201516", "#e6d6d6"],
    }),
  },
  {
    id: "arctic",
    label: "Arctic",
    appearance: "light",
    description: "Cool pale surfaces with clear fjord-blue structure.",
    colors: themeColors({
      surface: ["#edf3f5", "#e3ecef", "#f3f7f8", "#f8fbfc", "#e7eff2", "#ffffff", "#21343bd1"],
      text: ["#17272d", "#465d66", "#6d858e", "#f8fcfd"],
      border: ["#cfdee3", "#9fb4bc"],
      interaction: ["#146f92", "#c2e5f1", "#0c2934"],
      accent: ["#207b9e", "#176887", "#11536d", "#d3ebf3", "#ffffff"],
      status: ["#2f7c52", "#936a11", "#ad433f", "#236f98"],
      statusSurface: ["#d9eee2", "#f4e9c8", "#f5dddd", "#d8eaf3"],
      diff: ["#dbeee2", "#b5ddc4", "#21623b", "#f5dfdf", "#e8baba", "#963833", "#f4f8f9"],
      syntax: ["#176d98", "#477b35", "#896112", "#107970", "#304b57", "#a04e27", "#71858d"],
      ansi: [
        "#22343a",
        "#ad443f",
        "#2f7b51",
        "#8c681a",
        "#25759e",
        "#7a637f",
        "#1f7976",
        "#d8e3e6",
        "#61767e",
        "#c75b54",
        "#499765",
        "#a78331",
        "#438eb4",
        "#977c9a",
        "#419593",
        "#ffffff",
      ],
      chrome: ["#e2ecef", "#20333a"],
    }),
  },
  {
    id: "paper",
    label: "Paper",
    appearance: "light",
    description: "Warm ivory, graphite ink, and classic editorial blue.",
    colors: themeColors({
      surface: ["#f4f0e7", "#ece6da", "#faf7f0", "#fdfbf6", "#eee8dc", "#ffffff", "#28241ed1"],
      text: ["#26241f", "#575249", "#7d766b", "#fffdf8"],
      border: ["#ded7ca", "#b4ab9e"],
      interaction: ["#1f668b", "#cce2ed", "#122833"],
      accent: ["#2c6f92", "#225d7b", "#1a4a63", "#d9e8ef", "#ffffff"],
      status: ["#37784a", "#916814", "#a9433d", "#2b6c91"],
      statusSurface: ["#dfecdf", "#f3e7c7", "#f3ded9", "#dce8ee"],
      diff: ["#e1ece0", "#bcd9bd", "#2b6037", "#f2dfda", "#e5bcb5", "#903831", "#faf7f0"],
      syntax: ["#255f82", "#4c7332", "#835b12", "#216f66", "#39474d", "#99502a", "#7c766c"],
      ansi: [
        "#302d27",
        "#aa463f",
        "#397648",
        "#896414",
        "#2d6b91",
        "#795e78",
        "#27726f",
        "#ddd7cc",
        "#70695f",
        "#c25a52",
        "#53915f",
        "#a47e2d",
        "#4a87ab",
        "#967894",
        "#48908b",
        "#fffdf8",
      ],
      chrome: ["#ebe5d9", "#2d2a24"],
    }),
  },
  {
    id: "high-contrast",
    label: "High Contrast",
    appearance: "dark",
    description: "Maximum separation, explicit focus, and robust forced-color fallback.",
    colors: themeColors({
      surface: ["#000000", "#080808", "#101010", "#151515", "#1b1b1b", "#242424", "#000000ed"],
      text: ["#ffffff", "#e4e4e4", "#b8b8b8", "#000000"],
      border: ["#686868", "#d0d0d0"],
      interaction: ["#68c8ff", "#075d88", "#ffffff"],
      accent: ["#64c7ff", "#91d7ff", "#3db2f4", "#073c59", "#000000"],
      status: ["#70e296", "#ffd25d", "#ff817a", "#6dceff"],
      statusSurface: ["#0d3b1d", "#493900", "#4b1010", "#073952"],
      diff: ["#0a3618", "#14692e", "#a2f1b8", "#460d0d", "#851c1c", "#ffb0ab", "#101010"],
      syntax: ["#87d3ff", "#a6e47e", "#ffd36e", "#6ee7d3", "#ffffff", "#ffac7a", "#b8b8b8"],
      ansi: [
        "#000000",
        "#ff7770",
        "#68df8f",
        "#ffd05b",
        "#63bfff",
        "#d3a1d3",
        "#5ed7d2",
        "#e3e3e3",
        "#9a9a9a",
        "#ff9b95",
        "#93f0ae",
        "#ffe08d",
        "#90d2ff",
        "#e4bde4",
        "#8ae9e5",
        "#ffffff",
      ],
      chrome: ["#000000", "#ffffff"],
    }),
  },
] as const satisfies readonly ThemePreset[];

export const DEFAULT_THEME_ID: ThemeId = "graphite";

const THEME_BY_ID: ReadonlyMap<ThemeId, ThemePreset> = new Map(
  THEME_PRESETS.map((preset) => [preset.id, preset]),
);

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_BY_ID.has(value as ThemeId);
}

export function getThemePreset(id: ThemeId): ThemePreset {
  return THEME_BY_ID.get(id) ?? THEME_PRESETS[0];
}

export function themeTokenToCssVariable(token: ThemeColorToken): `--color-${string}` {
  return `--color-${token.replaceAll(".", "-")}`;
}

export const INTERFACE_FONT_CHOICES = [
  {
    id: "system",
    label: "System UI",
    family:
      'Inter, "Segoe UI Variable", "SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  {
    id: "humanist",
    label: "Humanist",
    family: '"Atkinson Hyperlegible Next", "Segoe UI", Arial, sans-serif',
  },
  {
    id: "editorial",
    label: "Editorial",
    family: '"Noto Serif", Georgia, "Times New Roman", serif',
  },
  {
    id: "accessible",
    label: "OpenDyslexic",
    family: 'OpenDyslexic, "Atkinson Hyperlegible Next", Arial, sans-serif',
  },
] as const;

export const CODE_FONT_CHOICES = [
  {
    id: "system-mono",
    label: "System Mono",
    family: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    family: '"JetBrains Mono", "Cascadia Code", monospace',
  },
  {
    id: "source-code",
    label: "Source Code Pro",
    family: '"Source Code Pro", "Cascadia Mono", monospace',
  },
] as const;

export type InterfaceFontId = (typeof INTERFACE_FONT_CHOICES)[number]["id"];
export type CodeFontId = (typeof CODE_FONT_CHOICES)[number]["id"];
export type UiFontId = InterfaceFontId;
export type Density = "comfortable" | "compact";
export type PanelSpacing = "tight" | "balanced" | "airy";
export type RadiusPreset = "square" | "subtle" | "soft" | "round";
export type RadiusScale = RadiusPreset;
export type MotionPreference = "system" | "full" | "reduced" | "none";

export interface ThemePreferences {
  readonly version: typeof THEME_FILE_VERSION;
  readonly themeId: ThemeId;
  readonly interfaceFont: InterfaceFontId;
  readonly codeFont: CodeFontId;
  readonly bodySize: number;
  readonly codeSize: number;
  readonly bodyWeight: number;
  readonly bodyLineHeight: number;
  readonly codeLineHeight: number;
  readonly ligatures: boolean;
  readonly density: Density;
  readonly panelSpacing: PanelSpacing;
  readonly radius: RadiusPreset;
  readonly radiusOverride: number | null;
  readonly motion: MotionPreference;
  readonly motionScale: number;
  readonly streamingCursor: boolean;
  readonly colorOverrides: Readonly<Partial<Record<ThemeColorToken, string>>>;
}

export type ThemePreferencePatch = Partial<Omit<ThemePreferences, "version" | "colorOverrides">> & {
  readonly colorOverrides?: Readonly<Partial<Record<ThemeColorToken, string>>>;
};

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = Object.freeze({
  version: THEME_FILE_VERSION,
  themeId: DEFAULT_THEME_ID,
  interfaceFont: "system",
  codeFont: "system-mono",
  bodySize: 14,
  codeSize: 13,
  bodyWeight: 400,
  bodyLineHeight: 1.55,
  codeLineHeight: 1.5,
  ligatures: true,
  density: "comfortable",
  panelSpacing: "balanced",
  radius: "soft",
  radiusOverride: null,
  motion: "system",
  motionScale: 1,
  streamingCursor: true,
  colorOverrides: Object.freeze({}),
});

const interfaceFontIds = new Set<string>(INTERFACE_FONT_CHOICES.map((choice) => choice.id));
const codeFontIds = new Set<string>(CODE_FONT_CHOICES.map((choice) => choice.id));
const colorTokenSet = new Set<string>(THEME_COLOR_TOKENS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function isValidThemeColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  return CSS.supports("color", value);
}

function sanitizeColorOverrides(value: unknown): Partial<Record<ThemeColorToken, string>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<ThemeColorToken, string>> = {};
  for (const [token, color] of Object.entries(value)) {
    if (colorTokenSet.has(token) && isValidThemeColor(color)) {
      result[token as ThemeColorToken] = color;
    }
  }
  return result;
}

export function normalizeThemePreferences(value: unknown): ThemePreferences {
  const source = isRecord(value) ? value : {};
  const themeId = isThemeId(source.themeId) ? source.themeId : DEFAULT_THEME_PREFERENCES.themeId;
  const interfaceFont =
    typeof source.interfaceFont === "string" && interfaceFontIds.has(source.interfaceFont)
      ? (source.interfaceFont as InterfaceFontId)
      : DEFAULT_THEME_PREFERENCES.interfaceFont;
  const codeFont =
    typeof source.codeFont === "string" && codeFontIds.has(source.codeFont)
      ? (source.codeFont as CodeFontId)
      : DEFAULT_THEME_PREFERENCES.codeFont;
  const rawRadiusOverride = source.radiusOverride;

  return {
    version: THEME_FILE_VERSION,
    themeId,
    interfaceFont,
    codeFont,
    bodySize: boundedNumber(source.bodySize, DEFAULT_THEME_PREFERENCES.bodySize, 12, 24),
    codeSize: boundedNumber(source.codeSize, DEFAULT_THEME_PREFERENCES.codeSize, 11, 24),
    bodyWeight: boundedNumber(source.bodyWeight, DEFAULT_THEME_PREFERENCES.bodyWeight, 350, 700),
    bodyLineHeight: boundedNumber(
      source.bodyLineHeight,
      DEFAULT_THEME_PREFERENCES.bodyLineHeight,
      1.25,
      2,
    ),
    codeLineHeight: boundedNumber(
      source.codeLineHeight,
      DEFAULT_THEME_PREFERENCES.codeLineHeight,
      1.2,
      2,
    ),
    ligatures:
      typeof source.ligatures === "boolean"
        ? source.ligatures
        : DEFAULT_THEME_PREFERENCES.ligatures,
    density: enumValue(
      source.density,
      ["comfortable", "compact"],
      DEFAULT_THEME_PREFERENCES.density,
    ),
    panelSpacing: enumValue(
      source.panelSpacing,
      ["tight", "balanced", "airy"],
      DEFAULT_THEME_PREFERENCES.panelSpacing,
    ),
    radius: enumValue(
      source.radius,
      ["square", "subtle", "soft", "round"],
      DEFAULT_THEME_PREFERENCES.radius,
    ),
    radiusOverride:
      rawRadiusOverride === null
        ? null
        : typeof rawRadiusOverride === "number" && Number.isFinite(rawRadiusOverride)
          ? boundedNumber(rawRadiusOverride, 10, 0, 24)
          : DEFAULT_THEME_PREFERENCES.radiusOverride,
    motion: enumValue(
      source.motion,
      ["system", "full", "reduced", "none"],
      DEFAULT_THEME_PREFERENCES.motion,
    ),
    motionScale: boundedNumber(source.motionScale, DEFAULT_THEME_PREFERENCES.motionScale, 0.25, 2),
    streamingCursor:
      typeof source.streamingCursor === "boolean"
        ? source.streamingCursor
        : DEFAULT_THEME_PREFERENCES.streamingCursor,
    colorOverrides: sanitizeColorOverrides(source.colorOverrides),
  };
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadThemePreferences(
  storage: Storage | null = getBrowserStorage(),
): ThemePreferences {
  if (!storage) return normalizeThemePreferences(DEFAULT_THEME_PREFERENCES);
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return stored
      ? normalizeThemePreferences(JSON.parse(stored) as unknown)
      : normalizeThemePreferences(DEFAULT_THEME_PREFERENCES);
  } catch {
    return normalizeThemePreferences(DEFAULT_THEME_PREFERENCES);
  }
}

export function saveThemePreferences(
  preferences: ThemePreferences,
  storage: Storage | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify(normalizeThemePreferences(preferences)));
    return true;
  } catch {
    return false;
  }
}

export function clearThemePreferences(storage: Storage | null = getBrowserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(THEME_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function resolveFontFamily<T extends { readonly id: string; readonly family: string }>(
  choices: readonly T[],
  id: string,
): string {
  return choices.find((choice) => choice.id === id)?.family ?? choices[0].family;
}

const RADIUS_VALUES: Readonly<Record<RadiusPreset, readonly [number, number, number, number]>> = {
  square: [0, 2, 4, 6],
  subtle: [3, 5, 7, 9],
  soft: [4, 6, 10, 12],
  round: [6, 9, 14, 18],
};

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

function effectiveMotionScale(preferences: ThemePreferences): number {
  if (preferences.motion === "none") return 0;
  if (preferences.motion === "reduced") return 0.35;
  if (preferences.motion === "system" && prefersReducedMotion()) return 0.35;
  return preferences.motionScale;
}

export function applyThemePreferences(
  value: ThemePreferences,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): ThemePreferences {
  const preferences = normalizeThemePreferences(value);
  if (!root) return preferences;

  const preset = getThemePreset(preferences.themeId);
  const colors = { ...preset.colors, ...preferences.colorOverrides };
  for (const token of THEME_COLOR_TOKENS) {
    root.style.setProperty(themeTokenToCssVariable(token), colors[token]);
  }

  root.dataset.theme = preset.id;
  root.dataset.appearance = preset.appearance;
  root.dataset.density = preferences.density;
  root.dataset.panelSpacing = preferences.panelSpacing;
  root.dataset.radius = preferences.radius;
  root.dataset.motion = preferences.motion;
  root.dataset.streamingCursor = String(preferences.streamingCursor);
  root.style.colorScheme = preset.appearance;
  root.style.setProperty(
    "--font-interface",
    resolveFontFamily(INTERFACE_FONT_CHOICES, preferences.interfaceFont),
  );
  root.style.setProperty("--font-code", resolveFontFamily(CODE_FONT_CHOICES, preferences.codeFont));
  root.style.setProperty("--font-size-body", `${preferences.bodySize}px`);
  root.style.setProperty("--font-size-code", `${preferences.codeSize}px`);
  root.style.setProperty("--font-weight-body", String(preferences.bodyWeight));
  root.style.setProperty("--line-height-body", String(preferences.bodyLineHeight));
  root.style.setProperty("--line-height-code", String(preferences.codeLineHeight));
  root.style.setProperty("--font-code-ligatures", preferences.ligatures ? "normal" : "none");
  root.style.setProperty("--density-scale", preferences.density === "compact" ? "0.82" : "1");
  root.style.setProperty(
    "--panel-gap",
    preferences.panelSpacing === "tight"
      ? "8px"
      : preferences.panelSpacing === "airy"
        ? "20px"
        : "12px",
  );
  const motionScale = effectiveMotionScale(preferences);
  root.style.setProperty("--motion-scale", String(motionScale));
  root.style.setProperty("--duration-instant", `${Math.round(80 * motionScale)}ms`);
  root.style.setProperty("--duration-fast", `${Math.round(140 * motionScale)}ms`);
  root.style.setProperty("--duration-moderate", `${Math.round(220 * motionScale)}ms`);
  root.style.setProperty("--duration-slow", `${Math.round(340 * motionScale)}ms`);
  root.style.setProperty("--duration-cursor", `${Math.max(320, Math.round(900 * motionScale))}ms`);

  const radius = RADIUS_VALUES[preferences.radius];
  const medium = preferences.radiusOverride ?? radius[2];
  root.style.setProperty(
    "--radius-xs",
    `${preferences.radiusOverride === null ? radius[0] : Math.max(0, medium - 6)}px`,
  );
  root.style.setProperty(
    "--radius-sm",
    `${preferences.radiusOverride === null ? radius[1] : Math.max(0, medium - 4)}px`,
  );
  root.style.setProperty("--radius-md", `${medium}px`);
  root.style.setProperty(
    "--radius-lg",
    `${preferences.radiusOverride === null ? radius[3] : Math.min(28, medium + 2)}px`,
  );
  return preferences;
}

export interface SetThemeOptions {
  readonly root?: HTMLElement | null;
  readonly storage?: Storage | null;
  readonly persist?: boolean;
}

export function setThemePreferences(
  value: ThemePreferences,
  options: SetThemeOptions = {},
): ThemePreferences {
  const root =
    options.root === undefined
      ? typeof document === "undefined"
        ? null
        : document.documentElement
      : options.root;
  const normalized = applyThemePreferences(value, root);
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  if (options.persist !== false) saveThemePreferences(normalized, storage);
  return normalized;
}

export function updateThemePreferences(
  current: ThemePreferences,
  patch: ThemePreferencePatch,
  options: SetThemeOptions = {},
): ThemePreferences {
  return setThemePreferences(
    {
      ...current,
      ...patch,
      version: THEME_FILE_VERSION,
      colorOverrides: patch.colorOverrides ?? current.colorOverrides,
    },
    options,
  );
}

export function resetThemePreferences(options: SetThemeOptions = {}): ThemePreferences {
  return setThemePreferences(DEFAULT_THEME_PREFERENCES, options);
}

export function initializeTheme(options: SetThemeOptions = {}): ThemePreferences {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const preferences = loadThemePreferences(storage);
  return setThemePreferences(preferences, {
    ...options,
    storage,
    persist: false,
  });
}

export interface ThemeExportFile {
  readonly kind: "ai-integrator-theme";
  readonly version: typeof THEME_FILE_VERSION;
  readonly preferences: ThemePreferences;
}

export function exportThemePreferences(value: ThemePreferences): ThemeExportFile {
  return {
    kind: "ai-integrator-theme",
    version: THEME_FILE_VERSION,
    preferences: normalizeThemePreferences(value),
  };
}

export function importThemePreferences(value: unknown): ThemePreferences | null {
  if (
    !isRecord(value) ||
    value.kind !== "ai-integrator-theme" ||
    value.version !== THEME_FILE_VERSION
  )
    return null;
  return normalizeThemePreferences(value.preferences);
}
