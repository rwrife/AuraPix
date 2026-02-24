import { InMemoryAlbumsService } from "./inMemoryAlbumsService";

describe("InMemoryAlbumsService", () => {
  it("returns seed albums sorted newest-first", async () => {
    const svc = new InMemoryAlbumsService();
    const albums = await svc.listAlbums();
    expect(albums.length).toBeGreaterThan(0);
    expect(albums[0].name).toBe("Sample Highlights");
  });

  it("creates an album and returns it at the top of the list", async () => {
    const svc = new InMemoryAlbumsService();
    const created = await svc.createAlbum({ name: "My Trip" });
    expect(created.id).toMatch(/^album-/);
    expect(created.name).toBe("My Trip");

    const list = await svc.listAlbums();
    expect(list[0].id).toBe(created.id);
  });

  it("trims whitespace from album names", async () => {
    const svc = new InMemoryAlbumsService();
    const created = await svc.createAlbum({ name: "  Trimmed  " });
    expect(created.name).toBe("Trimmed");
  });

  it("rejects empty album names", async () => {
    const svc = new InMemoryAlbumsService();
    await expect(svc.createAlbum({ name: "   " })).rejects.toThrow(
      "Album name is required.",
    );
  });

  it("can be seeded with custom albums", async () => {
    const svc = new InMemoryAlbumsService([
      { id: "a1", name: "Custom", createdAt: new Date().toISOString() },
    ]);
    const albums = await svc.listAlbums();
    expect(albums).toHaveLength(1);
    expect(albums[0].name).toBe("Custom");
  });
});