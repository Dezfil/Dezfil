import { describe, expect, it, vi } from "vitest";
import type { PgConnection } from "@/lib/metadata/connections";
import {
  beginConnectionFormRequest,
  repointPasswordRequirement,
  type ConnectionFormFields,
} from "./ConnectionForm";

const connection: PgConnection = {
  id: "c1",
  name: "City",
  host: "db.example.org",
  port: 5432,
  database: "gis",
  username: "reader",
  ssl: true,
  createdAt: "2026-08-31T00:00:00.000Z",
  status: "connected",
  lastCheckedAt: "2026-08-31T00:00:00.000Z",
  lastCheckError: null,
  serverVersion: "PostgreSQL 16.4",
  postgisVersion: "3.4.3",
};

const fields: ConnectionFormFields = {
  name: connection.name,
  host: connection.host,
  port: String(connection.port),
  database: connection.database,
  username: connection.username,
  password: "",
  ssl: connection.ssl,
};

describe("connection form repoint credential guard", () => {
  it.each([
    ["host", { ...fields, host: "other.example.org" }],
    ["port", { ...fields, port: "6432" }],
    ["SSL-off", { ...fields, ssl: false }],
  ])("requires a password for a changed %s and refuses before fetch", (_case, changed) => {
    const send = vi.fn<typeof fetch>();

    expect(repointPasswordRequirement("edit", changed, connection)).toEqual({
      required: true,
      placeholder:
        "Enter the password again when changing the host or port, or turning SSL off.",
    });
    expect(() =>
      beginConnectionFormRequest(
        "edit",
        changed,
        connection,
        send,
      ),
    ).toThrow(
      "Enter the password again when changing the host or port, or turning SSL off.",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("restores the stored-password placeholder when the endpoint matches", () => {
    expect(
      repointPasswordRequirement(
        "edit",
        { ...fields, host: " DB.EXAMPLE.ORG. ", port: "05432" },
        connection,
      ),
    ).toEqual({
      required: false,
      placeholder: "Leave blank to keep the stored one",
    });
  });

  it("keeps the stored-password placeholder when SSL is turned on", () => {
    const withoutSsl = { ...connection, ssl: false };
    expect(
      repointPasswordRequirement(
        "edit",
        { ...fields, ssl: true },
        withoutSsl,
      ),
    ).toEqual({
      required: false,
      placeholder: "Leave blank to keep the stored one",
    });
  });

  it("sends an entered password and returns the server refusal sentence", async () => {
    const changed = {
      ...fields,
      host: "other.example.org",
      password: "entered-again",
    };
    const send = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: "connection_password_required",
            message:
              "Enter the password again when changing the host or port, or turning SSL off.",
          },
        },
        { status: 400 },
      ),
    );

    await expect(
      beginConnectionFormRequest(
        "edit",
        changed,
        connection,
        send,
      ),
    ).rejects.toThrow(
      "Enter the password again when changing the host or port, or turning SSL off.",
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(
      "/api/connections/postgis/c1",
    );
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
      host: "other.example.org",
      password: "entered-again",
    });
  });
});
