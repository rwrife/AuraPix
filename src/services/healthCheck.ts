/**
 * Health Check Service
 * Monitors backend API availability
 */

export interface HealthStatus {
  isHealthy: boolean;
  lastChecked: Date;
  error?: string;
}

export class HealthCheckService {
  private baseUrl: string;
  private checkInterval: number;
  private timeoutMs: number;
  private listeners: Set<(status: HealthStatus) => void>;
  private currentStatus: HealthStatus;
  private intervalId?: number;

  constructor(
    baseUrl: string,
    checkInterval = 30000, // 30 seconds
    timeoutMs = 5000 // 5 seconds
  ) {
    this.baseUrl = baseUrl;
    this.checkInterval = checkInterval;
    this.timeoutMs = timeoutMs;
    this.listeners = new Set();
    this.currentStatus = {
      isHealthy: true,
      lastChecked: new Date(),
    };
  }

  /**
   * Start periodic health checks
   */
  start(): void {
    console.log(`[HealthCheck] Starting health monitoring (checking every ${this.checkInterval / 1000}s)`);
    console.log(`[HealthCheck] Backend URL: ${this.baseUrl}`);
    
    // Perform initial check immediately
    this.performCheck();

    // Set up periodic checks
    this.intervalId = window.setInterval(() => {
      this.performCheck();
    }, this.checkInterval);
  }

  /**
   * Stop periodic health checks
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Perform a single health check
   */
  async performCheck(): Promise<HealthStatus> {
    const endpoint = `${this.baseUrl}/internal/health`;
    console.log('[HealthCheck] Checking endpoint:', endpoint);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      const isHealthy = response.ok;
      const status: HealthStatus = {
        isHealthy,
        lastChecked: new Date(),
        error: isHealthy ? undefined : `HTTP ${response.status}`,
      };

      console.log('[HealthCheck] Result:', status);
      this.updateStatus(status);
      return status;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to reach backend service';
      console.error('[HealthCheck] Error:', errorMessage, error);
      
      const status: HealthStatus = {
        isHealthy: false,
        lastChecked: new Date(),
        error: errorMessage,
      };

      this.updateStatus(status);
      return status;
    }
  }

  /**
   * Subscribe to health status changes
   */
  subscribe(listener: (status: HealthStatus) => void): () => void {
    this.listeners.add(listener);
    // Immediately notify with current status
    listener(this.currentStatus);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get current health status
   */
  getStatus(): HealthStatus {
    return this.currentStatus;
  }

  /**
   * Update status and notify listeners
   */
  private updateStatus(status: HealthStatus): void {
    const previousHealth = this.currentStatus.isHealthy;
    this.currentStatus = status;

    // Notify listeners if health status changed or on every check
    if (previousHealth !== status.isHealthy || this.listeners.size > 0) {
      this.listeners.forEach((listener) => listener(status));
    }
  }
}

// Singleton instance
let healthCheckService: HealthCheckService | null = null;

export function getHealthCheckService(): HealthCheckService {
  if (!healthCheckService) {
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
    healthCheckService = new HealthCheckService(apiBaseUrl);
  }
  return healthCheckService;
}

export function initializeHealthCheck(): void {
  const service = getHealthCheckService();
  service.start();
}

export function cleanupHealthCheck(): void {
  if (healthCheckService) {
    healthCheckService.stop();
    healthCheckService = null;
  }
}