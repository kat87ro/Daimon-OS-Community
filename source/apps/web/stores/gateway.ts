"use client";

import { create } from "zustand";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

interface GatewayState {
  connState: ConnState;
  channelCount: number;
  setConnState(connState: ConnState): void;
  setChannelCount(channelCount: number): void;
}

export const useGatewayStore = create<GatewayState>((set) => ({
  connState: "closed",
  channelCount: 0,
  setConnState: (connState) => set({ connState }),
  setChannelCount: (channelCount) => set({ channelCount }),
}));
