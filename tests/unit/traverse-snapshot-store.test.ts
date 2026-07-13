import type { SnapshotStore } from "@kontourai/traverse/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createSupabaseSnapshotStoreMock, supabaseStore } = vi.hoisted(() => {
  const store = {
    put: vi.fn(),
    latest: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  } satisfies SnapshotStore;
  return {
    createSupabaseSnapshotStoreMock: vi.fn(() => store),
    supabaseStore: store,
  };
});

vi.mock("@/lib/ingestion/supabase-snapshot-store", () => ({
  createSupabaseSnapshotStore: createSupabaseSnapshotStoreMock,
}));

import { createCampfitSnapshotStore } from "@/lib/ingestion/traverse-snapshot-store";

afterEach(() => {
  vi.unstubAllEnvs();
  createSupabaseSnapshotStoreMock.mockClear();
});

describe("createCampfitSnapshotStore", () => {
  it("selects Supabase Storage when both service-role environment values are set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");

    expect(createCampfitSnapshotStore()).toBe(supabaseStore);
    expect(createSupabaseSnapshotStoreMock).toHaveBeenCalledOnce();
  });

  it("keeps the filesystem store when either service-role environment value is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const store = createCampfitSnapshotStore("/tmp/campfit-snapshot-unit-test");

    expect(store).not.toBe(supabaseStore);
    expect(createSupabaseSnapshotStoreMock).not.toHaveBeenCalled();
  });
});
