import { create } from 'zustand';

type State = {
  activeEnvironment: string | null;
  setActiveEnvironment: (env: string | null) => void;
};

export const useProductionContext = create<State>((set) => ({
  activeEnvironment: null,
  setActiveEnvironment: (env) => set({ activeEnvironment: env }),
}));
