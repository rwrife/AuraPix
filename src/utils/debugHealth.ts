/**
 * Debug utility for health check system
 * Available in browser console as window.__debugHealth
 */

import { getHealthCheckService } from '../services/healthCheck';

declare global {
  interface Window {
    __debugHealth?: {
      service: ReturnType<typeof getHealthCheckService>;
      check: () => ReturnType<ReturnType<typeof getHealthCheckService>['performCheck']>;
      status: () => ReturnType<ReturnType<typeof getHealthCheckService>['getStatus']>;
      subscribe: () => ReturnType<ReturnType<typeof getHealthCheckService>['subscribe']>;
    };
  }
}

export function setupHealthDebug() {
  if (typeof window !== 'undefined') {
    window.__debugHealth = {
      service: getHealthCheckService(),
      
      // Manually trigger a health check
      check: async () => {
        const service = getHealthCheckService();
        const status = await service.performCheck();
        console.log('Health Check Result:', status);
        return status;
      },
      
      // Get current status
      status: () => {
        const service = getHealthCheckService();
        const status = service.getStatus();
        console.log('Current Health Status:', status);
        return status;
      },
      
      // Subscribe to changes
      subscribe: () => {
        const service = getHealthCheckService();
        return service.subscribe((status) => {
          console.log('Health Status Update:', status);
        });
      },
    };
    
    console.log('🩺 Health Debug Tools loaded. Try:');
    console.log('  __debugHealth.check()   - Run health check now');
    console.log('  __debugHealth.status()  - Get current status');
    console.log('  __debugHealth.subscribe() - Watch for changes');
  }
}