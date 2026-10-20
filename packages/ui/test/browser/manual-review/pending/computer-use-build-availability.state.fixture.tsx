export const useSettings = () => ({ settings: {}, update: async () => {} });
export const usePluginManagementStore = (selector: (state: unknown) => unknown) =>
  selector({
    plugins: [{ id: "computer-use@zcode-plugins-official", enabled: true }],
    initialize: async () => {
      (window as any).__cuaCalls.initialize++;
    },
    setEnabled: async () => {
      (window as any).__cuaCalls.toggle++;
    },
    togglingPluginId: null,
  });
