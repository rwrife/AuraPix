import { useEffect, useState } from 'react';
import { getHealthCheckService, type HealthStatus } from '../services/healthCheck';

export function HealthBanner() {
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);

  useEffect(() => {
    const healthService = getHealthCheckService();
    
    // Subscribe to health status updates
    const unsubscribe = healthService.subscribe((status) => {
      setHealthStatus(status);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Don't show banner if service is healthy or we haven't checked yet
  if (!healthStatus || healthStatus.isHealthy) {
    return null;
  }

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        backgroundColor: '#dc2626',
        color: 'white',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        fontSize: '14px',
        fontWeight: 500,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
          fill="currentColor"
        />
      </svg>
      <div>
        <strong>Service Unavailable:</strong> Unable to connect to the backend service.
        {healthStatus.error && (
          <span style={{ marginLeft: '8px', opacity: 0.9 }}>
            ({healthStatus.error})
          </span>
        )}
      </div>
    </div>
  );
}