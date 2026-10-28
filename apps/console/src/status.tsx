import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { ShowAll, problemOf, useDecision } from './decide';
import type { Incident } from './types';
import { Alert, Button, Card, when } from './ui';

const COMPONENTS = [
  'storefronts',
  'checkout',
  'admin',
  'payments',
  'couriers',
  'whatsapp',
  'sms',
  'email',
] as const;

const STATUSES: Record<Incident['kind'], string[]> = {
  incident: ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenance: ['scheduled', 'in_progress', 'completed'],
};

const field = 'rounded-control border border-line bg-surface p-2';

/** Posts an incident as it begins, or maintenance ahead of time. */
function Post() {
  const id = useId();
  const [kind, setKind] = useState<Incident['kind']>('incident');
  const [impact, setImpact] = useState<Incident['impact']>('degraded');
  const [components, setComponents] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [titleUr, setTitleUr] = useState('');
  const [body, setBody] = useState('');
  const [bodyUr, setBodyUr] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const post = useDecision<{ incident: Incident }>('/incidents', [['incidents']]);
  const toggle = (component: string) =>
    setComponents((now) =>
      now.includes(component) ? now.filter((each) => each !== component) : [...now, component],
    );
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Post to the status page</h2>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-medium">What</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as Incident['kind'])}
            className={field}
          >
            <option value="incident">An incident, now</option>
            <option value="maintenance">Maintenance, planned</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">How badly</span>
          <select
            value={impact}
            onChange={(event) => setImpact(event.target.value as Incident['impact'])}
            className={field}
          >
            <option value="degraded">Working, but badly</option>
            <option value="outage">Not working</option>
          </select>
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="font-medium">What it touches</legend>
        {COMPONENTS.map((component) => (
          <label key={component} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={components.includes(component)}
              onChange={() => toggle(component)}
            />
            {component}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-title`} className="font-medium">
        Title
      </label>
      <input
        id={`${id}-title`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className={field}
      />
      <label htmlFor={`${id}-title-ur`} className="font-medium">
        Title in Urdu (optional)
      </label>
      <input
        id={`${id}-title-ur`}
        lang="ur"
        dir="rtl"
        value={titleUr}
        onChange={(e) => setTitleUr(e.target.value)}
        className={field}
      />
      <label htmlFor={`${id}-body`} className="font-medium">
        What Hatti says
      </label>
      <textarea
        id={`${id}-body`}
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={field}
      />
      <label htmlFor={`${id}-body-ur`} className="font-medium">
        In Urdu (optional)
      </label>
      <textarea
        id={`${id}-body-ur`}
        lang="ur"
        dir="rtl"
        rows={2}
        value={bodyUr}
        onChange={(e) => setBodyUr(e.target.value)}
        className={field}
      />
      {kind === 'maintenance' && (
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Begins</span>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Ends</span>
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className={field}
            />
          </label>
        </div>
      )}
      {post.isError && <Alert tone="danger">{problemOf(post.error)}</Alert>}
      {post.isSuccess && (
        <Alert tone="success">Posted: the status page and every admin show it.</Alert>
      )}
      <Button
        className="self-start"
        busy={post.isPending}
        onClick={() =>
          post.mutate({
            kind,
            impact,
            components,
            title,
            titleUr,
            body,
            bodyUr,
            // Times as Pakistan's, as Hatti's people type them.
            ...(kind === 'maintenance' && startsAt && { startsAt: `${startsAt}+05:00` }),
            ...(kind === 'maintenance' && endsAt && { endsAt: `${endsAt}+05:00` }),
          })
        }
      >
        Post it
      </Button>
    </Card>
  );
}

/** What Hatti says next of an incident, with its status: the last ends it. */
function Update({ incident }: { incident: Incident }) {
  const id = useId();
  const statuses = STATUSES[incident.kind];
  const [status, setStatus] = useState(
    statuses[statuses.indexOf(incident.status) + 1] ?? incident.status,
  );
  const [body, setBody] = useState('');
  const update = useDecision<{ incident: Incident }>(`/incidents/${incident.id}/update`, [
    ['incidents'],
  ]);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-status`} className="font-medium">
        Now
      </label>
      <select
        id={`${id}-status`}
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        className={field}
      >
        {statuses.map((each) => (
          <option key={each} value={each}>
            {each}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-body`} className="font-medium">
        What Hatti says now
      </label>
      <textarea
        id={`${id}-body`}
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={field}
      />
      {update.isError && <Alert tone="danger">{problemOf(update.error)}</Alert>}
      <Button
        variant="secondary"
        className="self-start"
        busy={update.isPending}
        onClick={() => update.mutate({ status, body })}
      >
        Post the update
      </Button>
    </div>
  );
}

/** Hatti's status page (ADR-498): incidents and maintenance, posted and updated until they end. */
export function StatusPage() {
  const [all, setAll] = useState(false);
  const incidents = useQuery({
    queryKey: ['incidents', all],
    queryFn: () => consoleCall<{ incidents: Incident[] }>(`/incidents${all ? '?all=1' : ''}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Status page</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      {incidents.isPending ? (
        <p>Loading…</p>
      ) : incidents.isError ? (
        <Alert tone="danger">{errorText(incidents.error)}</Alert>
      ) : incidents.data.incidents.length === 0 ? (
        <p className="text-secondary">{all ? 'No incident yet.' : 'Nothing is going on.'}</p>
      ) : (
        incidents.data.incidents.map((incident) => (
          <Card key={incident.id} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">{incident.title}</h2>
            {incident.titleUr && (
              <p lang="ur" dir="rtl">
                {incident.titleUr}
              </p>
            )}
            <p className="text-secondary">
              {incident.kind} · {incident.impact} · {incident.status} · touches{' '}
              {incident.components.join(', ')} · from {when(incident.startsAt)}
              {incident.endsAt && ` to ${when(incident.endsAt)}`}
            </p>
            <ol className="flex flex-col gap-1 border-l border-line pl-3">
              {incident.updates.map((update) => (
                <li key={`${update.postedAt}-${update.status}`}>
                  <span className="font-medium">{update.status}</span>: {update.body}{' '}
                  <span className="text-secondary">
                    ({update.postedBy}, {when(update.postedAt)})
                  </span>
                </li>
              ))}
            </ol>
            {!incident.resolvedAt && <Update incident={incident} />}
          </Card>
        ))
      )}
      <Post />
    </div>
  );
}
