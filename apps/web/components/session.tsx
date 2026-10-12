"use client";
import { createContext, useContext } from "react";

export interface Me {
  user: { id: string; email: string; name: string | null };
  workspace: { id: string; name: string; plan: string; role: "owner" | "admin" | "agent" | "viewer" };
  workspaces: { id: string; name: string; plan: string; role: string }[];
  metaMode: "live" | "fake";
}

export const SessionCtx = createContext<Me | null>(null);
export const useMe = () => useContext(SessionCtx)!;
export const canEdit = (me: Me) => me.workspace.role === "owner" || me.workspace.role === "admin";
