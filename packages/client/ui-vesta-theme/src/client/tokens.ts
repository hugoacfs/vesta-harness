/**
 * The Vesta ember palette as `--dsw-*` alias overrides. Every token carries a
 * value for both base palettes: `dark` is the Vesta home-page look (ground
 * #07080c, ember accents), `light` is a warm off-white counterpart so a user
 * who flips the Appearance preference keeps a coherent, legible surface.
 * Values are literal colors: the override layer is applied as inline `body`
 * variables, so it cannot lean on the base palette's static scale.
 */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

const EMBER_1 = '#ffc46b'
const EMBER_2 = '#ff7847'
const EMBER_3 = '#ff4d6d'
const EMBER_LIGHT = '#d9741f'
const EMBER_LIGHT_2 = '#e0642e'
const OK = '#42e29c'
const DOWN = '#ff5470'

const FONT_SANS = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
const FONT_CODE = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'"
const FONT_DISPLAY = "'Space Grotesk', 'Inter', system-ui, sans-serif"

/** One override entry: dark value first because Vesta is dark-first. */
function ember(dark: string, light: string): { light: string; dark: string } {
  return { light, dark }
}

/** Token names this layer overrides (the `--dsw-*` aliases plus the `--vesta-*` brand tokens). */
export type VestaTokenName = keyof typeof VESTA_TOKENS

/** The ember override layer. */
export const VESTA_TOKENS = {
  // ── typography ──────────────────────────────────────────────────────────
  '--dsw-font-family': ember(FONT_SANS, FONT_SANS),
  '--ds-font-family-code': ember(FONT_CODE, FONT_CODE),
  '--vesta-font-display': ember(FONT_DISPLAY, FONT_DISPLAY),

  // ── brand tokens consumed by the Vesta brand package ────────────────────
  '--vesta-ember-1': ember(EMBER_1, EMBER_LIGHT),
  '--vesta-ember-2': ember(EMBER_2, EMBER_LIGHT_2),
  '--vesta-ember-3': ember(EMBER_3, '#c8304d'),
  '--vesta-ember-gradient': ember(
    'linear-gradient(115deg, #ffffff 20%, #ffc46b 62%, #ff7847 88%)',
    'linear-gradient(115deg, #14161c 20%, #d9741f 70%, #e0642e 100%)',
  ),
  '--vesta-glow': ember('rgba(255, 120, 71, 0.45)', 'rgba(224, 100, 46, 0.35)'),

  // ── grounds and surfaces ────────────────────────────────────────────────
  '--dsw-alias-bg-base': ember('#07080c', '#f6f3ee'),
  '--dsw-alias-bg-layer-1': ember('#0d0f15', '#ffffff'),
  '--dsw-alias-bg-layer-2': ember('#12151d', '#fbf9f5'),
  '--dsw-alias-bg-layer-3': ember('#181c26', '#f1ede6'),
  '--dsw-alias-bg-overlay': ember('#1a1e29', '#e9e4db'),
  '--dsw-alias-bg-module-platform': ember('#0f1219', '#f3efe8'),
  '--dsw-alias-bg-multi-select': ember('#12151d', '#f3efe8'),
  '--dsw-alias-bg-skeleton': ember('rgba(255, 255, 255, 0.06)', 'rgba(0, 0, 0, 0.05)'),
  '--dsw-alias-bg-mask-drop': ember('rgba(7, 8, 12, 0.75)', 'rgba(255, 255, 255, 0.7)'),
  '--dsw-specific-sidebar-fill': ember('#090b10', '#f1ede6'),
  '--dsw-specific-sidebar-nav-item-active': ember('#181c26', '#e6e0d6'),
  '--dsw-specific-sidebar-nav-item-active-accent': ember('#2a2418', '#fbe3d6'),
  '--dsw-specific-sidebar-nav-item-hover': ember('#12151d', '#ebe6de'),
  '--dsw-specific-input-major': ember('#0f1219', '#ffffff'),
  '--dsw-specific-login-input': ember('#0d0f15', '#fbf9f5'),
  '--dsw-specific-selector': ember('#161a24', '#ede8e0'),
  '--dsw-specific-tip': ember('#12151d', '#f3efe8'),
  '--dsw-specific-bubble': ember('#161a24', '#f1ede6'),
  '--dsw-specific-bubble-highlight': ember('#2a2418', '#fbe3d6'),
  '--dsw-alias-toast-bg': ember('#1a1e29', '#14161c'),
  '--dsw-alias-tooltip-bg': ember('#1f2430', '#2a2d35'),

  // ── borders ─────────────────────────────────────────────────────────────
  '--dsw-alias-border-l1': ember('rgba(255, 255, 255, 0.05)', 'rgba(0, 0, 0, 0.05)'),
  '--dsw-alias-border-l2': ember('rgba(255, 255, 255, 0.08)', 'rgba(0, 0, 0, 0.1)'),
  '--dsw-alias-border-l2-darkmode-thin': ember('rgba(255, 255, 255, 0.08)', 'rgba(0, 0, 0, 0.1)'),
  '--dsw-alias-border-l3': ember('rgba(255, 255, 255, 0.12)', 'rgba(0, 0, 0, 0.13)'),
  '--dsw-alias-border-l4': ember('rgba(255, 255, 255, 0.18)', 'rgba(0, 0, 0, 0.18)'),
  '--dsw-alias-border-inverted': ember('rgba(255, 255, 255, 0.06)', 'rgba(0, 0, 0, 0)'),
  '--dsw-alias-border-inverted2': ember('rgba(255, 255, 255, 0.08)', 'rgba(0, 0, 0, 0)'),

  // ── text ────────────────────────────────────────────────────────────────
  '--dsw-alias-label-primary': ember('#eef1f6', '#14161c'),
  '--dsw-alias-label-primary-dimmed': ember('#d7dbe3', '#2a2d35'),
  '--dsw-alias-label-primary-bluish': ember('#eef1f6', '#14161c'),
  '--dsw-alias-label-primary-foreground': ember('#0b0c10', '#ffffff'),
  '--dsw-alias-label-primary-inverted': ember('#0b0c10', '#ffffff'),
  '--dsw-alias-label-secondary': ember('#8f97a8', '#4a5162'),
  '--dsw-alias-label-tertiary': ember('#5b6375', '#6b7386'),
  '--dsw-alias-label-caption': ember('#5b6375', '#8f97a8'),
  '--dsw-alias-label-dimmed': ember('#2a2f3b', '#cfd3db'),
  '--dsw-alias-brand-text': ember('#eef1f6', '#14161c'),

  // ── accent and buttons ──────────────────────────────────────────────────
  '--dsw-alias-brand-primary': ember(EMBER_1, EMBER_LIGHT),
  '--dsw-alias-brand-primary-invert': ember(EMBER_1, EMBER_LIGHT),
  '--dsw-alias-brand-primary-new-colorprimary-new-color': ember(EMBER_2, EMBER_LIGHT_2),
  '--dsw-alias-button-primary-fill': ember(EMBER_1, EMBER_LIGHT),
  '--dsw-alias-button-primary-hover': ember('#ffd28a', '#c4661a'),
  '--dsw-alias-button-primary-dimmed': ember('#2a2418', '#f3dcc4'),
  '--dsw-alias-button-contrast-fill': ember('#eef1f6', '#14161c'),
  '--dsw-alias-button-elevated-fill': ember('#1a1e29', '#ffffff'),
  '--dsw-alias-button-floating-fill': ember('#12151d', '#ffffff'),
  '--dsw-alias-button-floating-hover': ember('#181c26', '#f1ede6'),
  '--dsw-alias-button-ghost-active-border': ember('#5b6375', '#8f97a8'),
  '--dsw-alias-button-ghost-active-fill': ember('#181c26', '#eae5dc'),
  '--dsw-alias-button-ghost-active-hover': ember('#1f2430', '#e2dcd2'),
  '--dsw-alias-button-info-fill': ember(EMBER_2, EMBER_LIGHT_2),
  '--dsw-alias-button-info-hover': ember('#ff8f66', '#c9561f'),
  '--dsw-alias-interactive-bg-hover': ember('rgba(255, 255, 255, 0.06)', 'rgba(20, 22, 28, 0.06)'),
  '--dsw-alias-interactive-bg-active': ember('rgba(255, 255, 255, 0.1)', 'rgba(20, 22, 28, 0.1)'),
  '--dsw-alias-interactive-bg-hover-accent': ember('rgba(255, 196, 107, 0.16)', 'rgba(217, 116, 31, 0.14)'),
  '--dsw-alias-interactive-bg-hover-solid': ember('#181c26', '#ede8e0'),
  '--dsw-alias-interactive-bg-hover-danger': ember('rgba(255, 84, 112, 0.15)', 'rgba(255, 84, 112, 0.08)'),

  // ── markdown and code ───────────────────────────────────────────────────
  '--dsw-alias-markdown-code-block': ember('#0b0d13', '#f3efe8'),
  '--dsw-alias-markdown-code-block-banner': ember('#10131a', '#ebe6de'),
  '--dsw-alias-markdown-inline-code': ember('#161a24', '#ece7df'),
  '--dsw-alias-markdown-citation': ember('#161a24', '#ece7df'),
  '--dsw-alias-markdown-code-segment-selected': ember('#1a1e29', '#ffffff'),
  '--dsw-alias-markdown-code-segment-unselected': ember('#0f1219', '#f1ede6'),
  '--dsw-alias-markdown-placeholder': ember('#12151d', '#f3efe8'),
  '--dsw-alias-markdown-tag': ember('#161a24', '#ece7df'),
  '--dsw-alias-scrollbar-bg-l1': ember('#2a2f3b', '#cfd3db'),
  '--dsw-alias-scrollbar-bg-l2': ember('#343a48', '#c4c9d2'),
  '--dsw-alias-scrollbar-hover-l1': ember('#3d4453', '#b8bec9'),
  '--dsw-alias-scrollbar-hover-l2': ember('#48506a', '#aab1bd'),

  // ── states ──────────────────────────────────────────────────────────────
  '--dsw-alias-state-business-primary': ember(EMBER_2, EMBER_LIGHT_2),
  '--dsw-alias-state-business-tertiary': ember('#2b1a14', '#fbe3d6'),
  '--dsw-alias-state-error-primary': ember(DOWN, '#d9304f'),
  '--dsw-alias-state-error-secondary': ember('#ff7a8f', DOWN),
  '--dsw-alias-state-success-primary': ember(OK, '#1f9d6a'),
  '--dsw-alias-state-success-secondary': ember('#6eeab6', OK),
  '--dsw-alias-state-success-tertiary': ember('#103326', '#dcf7ea'),
  '--dsw-alias-state-warn-primary': ember(EMBER_1, '#d98a1f'),
  '--dsw-alias-state-warn-secondary': ember('#ffd28a', EMBER_1),
  '--dsw-alias-state-warn-tertiary': ember('#332a17', '#fff1d9'),
  '--dsw-alias-state-warn-label': ember('#ffb84a', '#b56e12'),
} satisfies ThemeTokenOverrides
