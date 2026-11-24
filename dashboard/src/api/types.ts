// Shapes of the API's JSON responses (docs/SPEC.md §6). Written by hand for now; they must match
// api/src/endpoints/routes.ts → toResponse().

export interface Endpoint {
  id: string;
  url: string;
  event_types: string[];
  active: boolean;
  created_at: string; // ISO 8601 — JSON has no date type
  updated_at: string;
}

// Only the create response carries the signing secret, and only once.
export interface CreatedEndpoint extends Endpoint {
  secret: string;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

// RFC 9457 problem details, as produced by api/src/http/problem.ts.
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { location?: string; path: string; message: string }[];
  request_id?: string;
}

export interface CreateEndpointInput {
  url: string;
  event_types?: string[];
}

export interface UpdateEndpointInput {
  url?: string;
  event_types?: string[];
  active?: boolean;
}
