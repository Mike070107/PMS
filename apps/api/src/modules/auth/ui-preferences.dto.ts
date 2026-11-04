import { IsBoolean, IsIn, ValidateIf } from 'class-validator';
export const UI_THEMES = ['slate','ocean','jade','indigo','sand','rose'] as const;
export type UiTheme = typeof UI_THEMES[number];
export interface UiPreferences { theme: UiTheme; sidebarCollapsed: boolean }
export class UpdateUiPreferencesDto {
 @ValidateIf((_,v)=>v!==undefined)
 @IsIn(UI_THEMES)
 theme?: UiTheme;
 @ValidateIf((_,v)=>v!==undefined)
 @IsBoolean()
 sidebarCollapsed?: boolean;
}
export function normalizeUiPreferences(value: unknown): UiPreferences {
 const p=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
 return {theme:UI_THEMES.includes(p.theme as UiTheme)?p.theme as UiTheme:'slate',sidebarCollapsed:p.sidebarCollapsed===true};
}
