import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchActivityStreams } from "../../src/crc/sources/strava.ts";
import { stravaApi } from "../../src/stravaClient.ts";

const ACTIVITY = {
    device_watts: true,
    athlete: { id: 9876543210987654321n.toString() },
};

function mockApi(streams: Record<string, { data: unknown[] }>) {
    return vi.spyOn(stravaApi, "get").mockImplementation((async (url: string) => {
        if (url.endsWith("/streams")) return { data: streams };
        return { data: ACTIVITY };
    }) as never);
}

let prevToken: string | undefined;

beforeEach(() => {
    prevToken = process.env.STRAVA_ACCESS_TOKEN;
    process.env.STRAVA_ACCESS_TOKEN = "test-token";
});

afterEach(() => {
    process.env.STRAVA_ACCESS_TOKEN = prevToken;
    vi.restoreAllMocks();
});

describe("fetchActivityStreams", () => {
    it("pide datos nativos: key_by_type, series_type=time y SIN resolution", async () => {
        const spy = mockApi({
            time: { data: [0, 1, 2] },
            watts: { data: [100, 110, 120] },
        });

        await fetchActivityStreams("1234567890123456789", undefined, { useCache: false });

        const call = spy.mock.calls.find(([url]) => String(url).endsWith("/streams"));
        const params = (call?.[1] as { params: Record<string, unknown> }).params;

        expect(params["key_by_type"]).toBe(true);
        expect(params["series_type"]).toBe("time");
        expect(params).not.toHaveProperty("resolution");
    });

    it("transporta el ID de 19 dígitos en la URL sin pasar por Number", async () => {
        const id = "1234567890123456789";
        const spy = mockApi({ time: { data: [0, 1] }, watts: { data: [1, 2] } });

        await fetchActivityStreams(id, undefined, { useCache: false });

        const urls = spy.mock.calls.map(([url]) => String(url));
        expect(urls.some((u) => u.includes(id))).toBe(true);
        // El ID corrupto (…6784) no debe aparecer en ninguna URL.
        expect(urls.some((u) => u.includes(String(Number(id))))).toBe(false);
    });

    it("devuelve los streams alineados y los metadatos de la actividad", async () => {
        mockApi({
            time: { data: [0, 1, 2] },
            watts: { data: [100, 110, 120] },
            heartrate: { data: [140, 141, 142] },
        });

        const r = await fetchActivityStreams("123", undefined, { useCache: false });

        expect(r.device_watts).toBe(true);
        expect(r.athlete_id).toBe(ACTIVITY.athlete.id);
        expect(r.aligned.time).toEqual([0, 1, 2]);
        expect(r.aligned.watts).toEqual([100, 110, 120]);
        expect(r.aligned.heartrate).toEqual([140, 141, 142]);
        expect(r.from_cache).toBe(false);
    });

    it("traduce grade_smooth a grade", async () => {
        mockApi({
            time: { data: [0, 1] },
            grade_smooth: { data: [1.5, 2.5] },
        });

        const r = await fetchActivityStreams("123", undefined, { useCache: false });
        expect(r.aligned.grade).toEqual([1.5, 2.5]);
    });

    it("alinea streams con muestreo irregular manteniendo la correspondencia", async () => {
        mockApi({
            time: { data: [0, 5, 10] },
            watts: { data: [100, 200, 300] },
            heartrate: { data: [150, 160, 170] },
        });

        const r = await fetchActivityStreams("123", undefined, { useCache: false });

        expect(r.aligned.time).toHaveLength(11);
        expect(r.aligned.watts).toHaveLength(11);
        expect(r.aligned.heartrate).toHaveLength(11);
        expect(r.aligned.watts![5]).toBe(200);
        expect(r.aligned.heartrate![5]).toBe(160);
    });

    it("rechaza un activityId que no sea solo dígitos", async () => {
        await expect(fetchActivityStreams("abc", undefined, { useCache: false })).rejects.toThrow(
            /dígitos/,
        );
    });

    it("falla claramente si la actividad no trae stream de tiempo", async () => {
        mockApi({ watts: { data: [1, 2, 3] } });

        await expect(fetchActivityStreams("123", undefined, { useCache: false })).rejects.toThrow(
            /stream de tiempo/,
        );
    });

    it("exige token de acceso", async () => {
        delete process.env.STRAVA_ACCESS_TOKEN;
        await expect(fetchActivityStreams("123", undefined, { useCache: false })).rejects.toThrow(
            /STRAVA_ACCESS_TOKEN/,
        );
    });
});
