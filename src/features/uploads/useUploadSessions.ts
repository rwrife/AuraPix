import { useCallback, useState } from 'react';
import type { UploadSessionsService } from '../../domain/uploads/contract';
import type {
  DerivativeJobEnvelope,
  UploadMetadata,
  UploadSession,
} from '../../domain/uploads/types';

interface UseUploadSessionsResult {
  pendingSession: UploadSession | null;
  metadata: UploadMetadata[];
  jobs: DerivativeJobEnvelope[];
  loading: boolean;
  error: string | null;
  replayedFinalize: boolean;
  createSession(fileName: string): Promise<void>;
  finalizeSession(fileName: string, byteSize: number): Promise<void>;
  createAndFinalizeSession(fileName: string, byteSize: number): Promise<void>;
  processNextDerivativeJob(): Promise<void>;
}

export function useUploadSessions(uploadService: UploadSessionsService): UseUploadSessionsResult {
  const [pendingSession, setPendingSession] = useState<UploadSession | null>(null);
  const [metadata, setMetadata] = useState<UploadMetadata[]>([]);
  const [jobs, setJobs] = useState<DerivativeJobEnvelope[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replayedFinalize, setReplayedFinalize] = useState(false);

  const createSession = useCallback(
    async (fileName: string) => {
      setLoading(true);
      setError(null);
      setReplayedFinalize(false);
      try {
        const session = await uploadService.createUploadSession({ fileName });
        setPendingSession(session);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Unable to create upload session.');
        }
      } finally {
        setLoading(false);
      }
    },
    [uploadService]
  );

  const finalizeSession = useCallback(
    async (fileName: string, byteSize: number) => {
      if (!pendingSession) {
        setError('Create an upload session first.');
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await uploadService.finalizeUpload({
          sessionId: pendingSession.sessionId,
          idempotencyKey: pendingSession.idempotencyKey,
          fileName,
          byteSize,
        });

        const nextMetadata = await uploadService.listUploadedMetadata();
        const nextJobs = await uploadService.listDerivativeJobs();
        setMetadata(nextMetadata);
        setJobs(nextJobs);
        setReplayedFinalize(result.idempotentReplay);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Unable to finalize upload.');
        }
      } finally {
        setLoading(false);
      }
    },
    [pendingSession, uploadService]
  );

  const createAndFinalizeSession = useCallback(
    async (fileName: string, byteSize: number) => {
      setLoading(true);
      setError(null);
      setReplayedFinalize(false);

      try {
        const session = await uploadService.createUploadSession({ fileName });
        setPendingSession(session);

        const result = await uploadService.finalizeUpload({
          sessionId: session.sessionId,
          idempotencyKey: session.idempotencyKey,
          fileName,
          byteSize,
        });

        const nextMetadata = await uploadService.listUploadedMetadata();
        const nextJobs = await uploadService.listDerivativeJobs();
        setMetadata(nextMetadata);
        setJobs(nextJobs);
        setReplayedFinalize(result.idempotentReplay);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Unable to complete upload session.');
        }
      } finally {
        setLoading(false);
      }
    },
    [uploadService]
  );

  const processNextDerivativeJob = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await uploadService.processNextDerivativeJob();
      const nextMetadata = await uploadService.listUploadedMetadata();
      const nextJobs = await uploadService.listDerivativeJobs();
      setMetadata(nextMetadata);
      setJobs(nextJobs);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Unable to process derivative jobs.');
      }
    } finally {
      setLoading(false);
    }
  }, [uploadService]);

  return {
    pendingSession,
    metadata,
    jobs,
    loading,
    error,
    replayedFinalize,
    createSession,
    finalizeSession,
    createAndFinalizeSession,
    processNextDerivativeJob,
  };
}
