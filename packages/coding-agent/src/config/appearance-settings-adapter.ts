export interface AppearanceSettingsAdapter {
	isLightTheme(name?: string): boolean;
	setAutoThemeMapping(mode: "dark" | "light", themeName: string): void;
	setSymbolPreset(preset: "unicode" | "nerd" | "ascii"): Promise<void>;
	setColorBlindMode(enabled: boolean): Promise<void>;
}

let adapter: AppearanceSettingsAdapter | undefined;

export function registerAppearanceSettingsAdapter(value: AppearanceSettingsAdapter): void {
	adapter = value;
}

export function getAppearanceSettingsAdapter(): AppearanceSettingsAdapter | undefined {
	return adapter;
}
