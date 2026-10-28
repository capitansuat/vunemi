/** Explicit execution constraint, not a claim that arbitrary apps support background input. */
export function backgroundOnly(goal: string | undefined): boolean {
  return goal !== undefined && /arka\s*plan|background|without\s+(?:changing|stealing)\s+(?:the\s+)?focus|odak\S*\s*değiş(?:tirme|meden|tirmeden)|ön\s+uygulamanın\s+odağını/iu.test(goal);
}
// Known focus-changing, generic native dispatch, or unbound browser input paths. Independent file/Craft/web
// work stays available. This list does not certify unknown third-party tools.
const FOREGROUND = new Set(['desktop_focus','desktop_describe','desktop_screenshot','desktop_click','desktop_type','desktop_key','calculator_multiply','app_command','finder_reveal','whatsapp_compose','browser_open_url','page_click','page_type','page_select','page_press','page_scroll','tabs_focus']);
export function backgroundFallback(name: string, goal: string | undefined): boolean {
  if (!backgroundOnly(goal)) return false;
  // system_run is the file package's allowlisted converter, not a shell or
  // generic app launcher. A Shortcut, however, can contain focus-changing steps.
  return FOREGROUND.has(name) || name === 'shortcuts_run';
}
// Known protected writers, including new adapter operations. Reads never consume
// the once-only input cap; an unrecognized tool name grants no native capability.
const BACKGROUND_MUTATIONS = new Set(['desktop_background_click','desktop_background_set_text','desktop_background_append_text','desktop_background_document','desktop_background_scroll_position','desktop_background_menu_open','desktop_background_menu_select','desktop_background_drag','desktop_document_move','files_move','page_target_act']);
export function backgroundMutation(name: string, goal: string | undefined): boolean {
  return backgroundOnly(goal) && BACKGROUND_MUTATIONS.has(name);
}
/** Only a deliberately narrow, explicit one-button request has an input cap. */
export function singleBackgroundPress(goal: string | undefined): boolean {
  const compound = /(?:then|afterwards|next)\s+(?:also\s+)?(?:drag|scroll|open\s+(?:the\s+)?menu|select\s+(?:the\s+)?menu)|(?:sonra|ardından)\s+(?:[^.!?;\n]{0,60}?\s+)?(?:sürükle(?!me)|kaydır(?!ma)|menüyü\s+aç|menü\s+öğesini\s+seç)/iu.test(goal??'');
  return !compound && backgroundOnly(goal) && /düğme|button|\bpress\b|\bclick\b/iu.test(goal!)
    && /bir\s+kez|tek\s+düğme|\bonce\b|single\s+(?:button|press|click)/iu.test(goal!)
    && !/arithmetic|calculate|hesapla|\d\s*[+×÷*/-]\s*\d|buttons|düğmeler/iu.test(goal!);
}
