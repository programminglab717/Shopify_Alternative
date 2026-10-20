import { Copy, FileText, Pencil, Search, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FileDeleteMutation, FileUpdateMutation, ShopFilesQuery } from '../api/operations';
import type { ShopFilesData, UserError } from '../api/types';
import { gate } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { useFileUpload } from '../shell/use-image-upload';
import { Button } from '../ui/button';
import { Alert, Card, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who keep the shop's files (`write_files`): owners, managers and marketers. */
export const KEEPS_FILES = gate(['owner', 'manager', 'marketer'], 'write_files');

/** How many of the shop's files a page shows. */
const FILES_AT_ONCE = 60;

/**
 * The shop's files (ADR-636): searched by the words of their names, the newest first, each
 * shown small with its link to copy, and deleted; pictures and PDFs added from the device.
 */
export function FilesTab() {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [query, setQuery] = useState('');
  // Each page's cursor, the first's none; "Show more" adds the next.
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const upload = useFileUpload();
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setQuery(words.trim());
    setPages([null]);
  };

  const add = async (chosen: FileList | null) => {
    if (!chosen || chosen.length === 0) return;
    setBusy(true);
    setProblems([]);
    const failed: string[] = [];
    for (const file of Array.from(chosen)) {
      try {
        const made = await upload(file);
        if ('problem' in made) failed.push(made.problem);
      } catch (error) {
        failed.push(errorText(error, t));
      }
    }
    setProblems(failed);
    setBusy(false);
    setPages([null]);
    if (picker.current) picker.current.value = '';
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 font-semibold">{t('shopFiles.title')}</h2>
        <input
          ref={picker}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="hidden"
          aria-label={t('shopFiles.choose')}
          onChange={(event) => void add(event.target.files)}
        />
        <Button
          busy={busy}
          icon={<Upload aria-hidden className="size-5" />}
          onClick={() => picker.current?.click()}
        >
          {t('shopFiles.add')}
        </Button>
      </div>
      <p className="text-secondary">{t('shopFiles.hint')}</p>
      {problems.map((problem) => (
        <Alert key={problem} tone="danger">
          {problem}
        </Alert>
      ))}
      <form onSubmit={search} className="flex flex-wrap items-end gap-2" role="search">
        <div className="min-w-0 flex-1">
          <TextField
            label={t('shopFiles.search')}
            dir="auto"
            maxLength={255}
            value={words}
            onChange={(event) => setWords(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" icon={<Search aria-hidden className="size-5" />}>
          {t('shopFiles.find')}
        </Button>
      </form>
      <ul className="flex flex-col divide-y divide-line">
        {pages.map((cursor, index) => (
          <FilesPage
            key={`${query}:${cursor ?? 'first'}`}
            query={query}
            after={cursor}
            onMore={
              index === pages.length - 1
                ? (next) => setPages((before) => [...before, next])
                : undefined
            }
          />
        ))}
      </ul>
    </Card>
  );
}

/** A page of the shop's files, as the search finds them; "Show more" on the last. */
function FilesPage({
  query,
  after,
  onMore,
}: {
  query: string;
  after: string | null;
  onMore?: (cursor: string) => void;
}) {
  const { t } = useLocale();
  const files = useAdminQuery<ShopFilesData>(['files', 'all', query, after], ShopFilesQuery, {
    first: FILES_AT_ONCE,
    after,
    query: query || null,
  });
  if (files.isPending) return <Loading label={t('shopFiles.loading')} />;
  if (files.error) return <Alert tone="danger">{errorText(files.error, t)}</Alert>;
  const { nodes, pageInfo } = files.data.files;
  return (
    <>
      {after === null && nodes.length === 0 && (
        <li className="py-3 text-secondary">
          {query ? t('shopFiles.noneFound') : t('shopFiles.none')}
        </li>
      )}
      {nodes.map((file) => (
        <FileRow key={file.id} file={file} />
      ))}
      {onMore && pageInfo.hasNextPage && pageInfo.endCursor && (
        <li className="pt-3">
          <Button variant="secondary" onClick={() => onMore(pageInfo.endCursor!)}>
            {t('shopFiles.more')}
          </Button>
        </li>
      )}
    </>
  );
}

/** A filename's extension with its dot, which a new name keeps (ADR-638): ".pdf"; "" for none. */
function extensionOf(filename: string): string {
  return /\.[^./\\]{1,16}$/.exec(filename)?.[0] ?? '';
}

/** One of the shop's files: small, named, its link to copy, renamed, deleted after asking. */
function FileRow({ file }: { file: ShopFilesData['files']['nodes'][number] }) {
  const { t } = useLocale();
  const rename = useAdminMutation<
    { fileUpdate: { files: { id: string; filename: string }[] | null; userErrors: UserError[] } },
    { files: { id: string; filename: string }[] }
  >(FileUpdateMutation);
  const extension = extensionOf(file.filename);
  // The name being written, without its extension, which stays; null when not renaming.
  const [name, setName] = useState<string | null>(null);
  const remove = useAdminMutation<
    { fileDelete: { deletedFileIds: string[] | null; userErrors: UserError[] } },
    { fileIds: string[] }
  >(FileDeleteMutation);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const drop = async () => {
    setProblem(null);
    try {
      const { fileDelete } = await remove.mutateAsync({ fileIds: [file.id] });
      const error = fileDelete.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (error) {
      setProblem(errorText(error, t));
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (name === null || name.trim() === '') return;
    setProblem(null);
    try {
      const { fileUpdate } = await rename.mutateAsync({
        files: [{ id: file.id, filename: `${name.trim()}${extension}` }],
      });
      const error = fileUpdate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setName(null);
    } catch (error) {
      setProblem(errorText(error, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {file.mimeType.startsWith('image/') ? (
          <img
            src={file.url}
            alt=""
            loading="lazy"
            className="size-12 flex-none rounded-control border border-line object-cover"
          />
        ) : (
          <FileText aria-hidden className="size-12 flex-none p-2 text-secondary" />
        )}
        <span className="min-w-0 flex-1 truncate" dir="auto">
          {file.filename}
        </span>
        <Button
          variant="tertiary"
          icon={<Copy aria-hidden className="size-5" />}
          aria-label={t('shopFiles.copyLink', { name: file.filename })}
          onClick={() => void navigator.clipboard?.writeText(file.url).then(() => setCopied(true))}
        >
          {copied ? t('shopFiles.copied') : t('shopFiles.copy')}
        </Button>
        <Button
          variant="tertiary"
          icon={<Pencil aria-hidden className="size-5" />}
          aria-label={t('shopFiles.renameName', { name: file.filename })}
          onClick={() => setName(file.filename.slice(0, file.filename.length - extension.length))}
        >
          {t('shopFiles.rename')}
        </Button>
        <Button
          variant="tertiary"
          icon={<Trash2 aria-hidden className="size-5" />}
          aria-label={t('shopFiles.deleteName', { name: file.filename })}
          onClick={() => setAsking(true)}
        >
          {t('shopFiles.delete')}
        </Button>
      </div>
      {name !== null && (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              label={t('shopFiles.newName')}
              dir="auto"
              maxLength={255 - extension.length}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          {extension && (
            <span className="pb-2 text-secondary" dir="ltr">
              {extension}
            </span>
          )}
          <Button type="submit" busy={rename.isPending} disabled={name.trim() === ''}>
            {t('shopFiles.renameSave')}
          </Button>
          <Button variant="tertiary" onClick={() => setName(null)}>
            {t('shopFiles.renameCancel')}
          </Button>
        </form>
      )}
      {asking && (
        <Alert tone="warning">
          <div className="flex flex-col gap-2">
            <span>{t('shopFiles.deleteAsk', { name: file.filename })}</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" busy={remove.isPending} onClick={() => void drop()}>
                {t('shopFiles.deleteConfirm')}
              </Button>
              <Button variant="tertiary" onClick={() => setAsking(false)}>
                {t('shopFiles.keep')}
              </Button>
            </div>
          </div>
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}
