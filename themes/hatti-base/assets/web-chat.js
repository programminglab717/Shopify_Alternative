// The chat on every page (MSG-10, ADR-811): opens its panel, starts a chat with the shopper's
// name, number and message, writes in it, and asks for the shop's answers every ten seconds while
// the panel is open. The session is the storefront's cookie, which this script never reads.
(() => {
  const root = document.querySelector('[data-web-chat]');
  if (!root) return;
  const open = root.querySelector('.web-chat__open');
  const panel = root.querySelector('.web-chat__panel');
  const list = root.querySelector('[data-web-chat-messages]');
  const start = root.querySelector('[data-web-chat-start]');
  const write = root.querySelector('[data-web-chat-write]');
  const problem = root.querySelector('[data-web-chat-problem]');
  const words = root.querySelector('[data-web-chat-words]').dataset;
  let timer = null;
  let shown = '';

  const say = (text) => {
    problem.textContent = text || '';
    problem.hidden = !text;
  };

  const show = (messages) => {
    const key = JSON.stringify(messages);
    if (key === shown) return;
    shown = key;
    list.replaceChildren(
      ...messages.map((message) => {
        const item = document.createElement('li');
        item.className = `web-chat__message web-chat__message--${message.from}`;
        const who = document.createElement('span');
        who.className = 'web-chat__who';
        who.textContent = message.from === 'shop' ? words.shop : words.you;
        const body = document.createElement('p');
        body.dir = 'auto';
        body.textContent = message.body;
        item.append(who, body);
        return item;
      }),
    );
    list.scrollTop = list.scrollHeight;
    // A chat begun: write in it from now.
    start.hidden = messages.length > 0;
    write.hidden = messages.length === 0;
  };

  const ask = async (method, path, body) => {
    const response = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const answer = await response.json().catch(() => ({}));
    if (response.status === 422) {
      say((answer.errors || []).map((error) => error.message).join('. '));
      return null;
    }
    if (response.status === 404) return { messages: [] };
    if (!response.ok) {
      say(answer.message || words.failed);
      return null;
    }
    say('');
    return answer;
  };

  const read = async () => {
    const answer = await ask('GET', '/chat/messages.json');
    if (answer) show(answer.messages);
  };

  const toggle = (opening) => {
    panel.hidden = !opening;
    open.setAttribute('aria-expanded', String(opening));
    clearInterval(timer);
    if (opening) {
      read();
      timer = setInterval(read, 10_000);
      (start.hidden ? write : start).querySelector('input, textarea').focus();
    }
  };

  open.addEventListener('click', () => toggle(panel.hidden));
  root.querySelector('[data-web-chat-close]').addEventListener('click', () => toggle(false));

  start.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(start));
    const answer = await ask('POST', '/chat', fields);
    if (answer) {
      start.reset();
      show(answer.messages);
    }
  });

  write.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = write.elements.body.value;
    const answer = await ask('POST', '/chat/messages', { body });
    if (answer) {
      write.reset();
      show(answer.messages);
    }
  });

  root.hidden = false;
})();
