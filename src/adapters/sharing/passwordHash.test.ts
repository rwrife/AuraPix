import { hashPassword, isVersionedPasswordHash, verifyPassword } from './passwordHash';

describe('passwordHash', () => {
  it('hashes and verifies password values', async () => {
    const hash = await hashPassword('open-sesame');

    expect(isVersionedPasswordHash(hash)).toBe(true);
    await expect(verifyPassword('open-sesame', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('uses unique salts per hash', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');

    expect(first).not.toBe(second);
  });
});
