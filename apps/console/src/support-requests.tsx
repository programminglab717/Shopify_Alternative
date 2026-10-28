import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConsoleError, consoleCall, errorText } from './api';
import type { AnsweredSupportRequest, SupportRequest } from './types';
import { Alert, Button, Card, when } from './ui';

/** How an answer went on WhatsApp (ADR-560), in a line; none for a request no one wrote there. */
function whatsAppLine(answered: AnsweredSupportRequest): string | null {
  switch (answered.whatsapp) {
    case 'sent':
      return 'Sent on WhatsApp too.';
    case 'window_closed':
      return 'Not sent on WhatsApp: more than 24 hours since they last wrote.';
    case 'unavailable':
      return 'Not sent on WhatsApp: the support number is not set up.';
    case 'failed':
      return `Not sent on WhatsApp: ${answered.whatsappError ?? 'it failed'}`;
    case 'none':
      return null;
  }
}

function RequestCard({
  request,
  onAnswered,
}: {
  request: SupportRequest;
  onAnswered: (answered: AnsweredSupportRequest) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () =>
      consoleCall<AnsweredSupportRequest>(`/support-requests/${request.id}/answer`, {
        method: 'POST',
        body: { answer },
      }),
    onSuccess: onAnswered,
    onError: (failure) =>
      setProblem(
        failure instanceof ConsoleError && failure.fields.answer
          ? failure.message
          : errorText(failure),
      ),
  });
  const field = `answer-${request.id}`;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {request.shop.name} <span className="text-secondary">· {request.shop.plan}</span>
        </h2>
        <span className={request.late ? 'font-semibold text-danger' : 'text-secondary'}>
          {request.late ? `Late: was due ${when(request.dueAt)}` : `Due ${when(request.dueAt)}`}
        </span>
      </div>
      <p className="text-secondary">
        {request.topic} · from the {request.channel === 'whatsapp' ? 'WhatsApp line' : 'admin'} · P
        {request.priority} · asked {when(request.createdAt)}
        {request.callBack && ` · call back on ${request.callBack}`}
      </p>
      <p lang={request.language} className="whitespace-pre-wrap">
        {request.message}
      </p>
      {request.lastInbound && request.lastInbound.text !== request.message && (
        <p className="text-secondary">
          Last on WhatsApp, {when(request.lastInbound.at)}:{' '}
          <span lang={request.language}>{request.lastInbound.text}</span>
        </p>
      )}
      <label htmlFor={field} className="font-medium">
        Answer{request.language === 'ur' ? ' (they asked in Urdu)' : ''}
      </label>
      <textarea
        id={field}
        rows={4}
        value={answer}
        lang={request.language}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => setAnswer(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        className="self-start"
        busy={send.isPending}
        onClick={() => {
          setProblem(null);
          send.mutate();
        }}
      >
        Send answer
      </Button>
    </Card>
  );
}

/** Shops' requests waiting for Hatti's people, the most urgent then the oldest first. */
export function SupportRequestsPage() {
  const client = useQueryClient();
  const requests = useQuery({
    queryKey: ['support-requests'],
    queryFn: () => consoleCall<{ requests: SupportRequest[] }>('/support-requests'),
  });
  const [said, setSaid] = useState<string | null>(null);
  const answered = (done: AnsweredSupportRequest) => {
    setSaid(
      [`Answered: ${done.request.shop.name} sees it in its admin.`, whatsAppLine(done)]
        .filter(Boolean)
        .join(' '),
    );
    void client.invalidateQueries({ queryKey: ['support-requests'] });
    void client.invalidateQueries({ queryKey: ['actions'] });
  };
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Support requests</h1>
      {said && <Alert tone="success">{said}</Alert>}
      {requests.isPending ? (
        <p>Loading…</p>
      ) : requests.isError ? (
        <Alert tone="danger">{errorText(requests.error)}</Alert>
      ) : requests.data.requests.length === 0 ? (
        <p className="text-secondary">No request waits.</p>
      ) : (
        requests.data.requests.map((each) => (
          <RequestCard key={each.id} request={each} onAnswered={answered} />
        ))
      )}
    </div>
  );
}
