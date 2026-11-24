import { ApiError } from '../api/client.ts';

// Shows an error from the API: the problem's detail/title plus one line per invalid field.
export function ErrorMessage({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message : 'Unexpected error';
  const fields = error instanceof ApiError ? (error.problem?.errors ?? []) : [];
  const requestId = error instanceof ApiError ? error.problem?.request_id : undefined;

  return (
    <div className="error" role="alert">
      <strong>{message}</strong>
      {fields.length > 0 && (
        <ul>
          {fields.map((field) => (
            <li key={`${field.path}:${field.message}`}>
              <code>{field.path || '(body)'}</code>: {field.message}
            </li>
          ))}
        </ul>
      )}
      {requestId && <small className="muted">request id: {requestId}</small>}
    </div>
  );
}
