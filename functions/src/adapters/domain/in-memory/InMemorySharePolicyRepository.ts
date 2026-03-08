import type {
  ShareGrant,
  SharePolicyRepository,
} from '../../../domain/sharing/SharingContracts.js';

export class InMemorySharePolicyRepository implements SharePolicyRepository {
  constructor(private readonly grants: ShareGrant[] = []) {}

  async findByToken(token: string): Promise<ShareGrant | null> {
    return this.grants.find(grant => grant.token === token) ?? null;
  }
}
