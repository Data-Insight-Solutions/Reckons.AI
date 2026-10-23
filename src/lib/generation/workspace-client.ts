import {
  GENERATION_DIR, OUTPUT_FILES, parseCapabilities, parseJob, parseRequest, sameRequest, validJobId,
  verifyOutput, type GenerationCapabilities, type GenerationJob, type GenerationRequest,
} from './protocol';

/** Capture the folder handle once; switching workspaces cannot redirect an in-flight request. */
export class WorkspaceGenerationClient {
  constructor(private readonly workspace: FileSystemDirectoryHandle) {}

  private async root() { return this.workspace.getDirectoryHandle(GENERATION_DIR); }
  private async jobDir(id: string, create = false) {
    if (!validJobId(id)) throw new Error('Invalid generation job ID');
    const jobs = await (await this.root()).getDirectoryHandle('jobs');
    return jobs.getDirectoryHandle(id, { create });
  }
  private async read(dir: FileSystemDirectoryHandle, name: string): Promise<unknown> {
    const file = await (await dir.getFileHandle(name)).getFile();
    if (file.size > 100_000) throw new Error('Generation metadata is too large');
    return JSON.parse(await file.text());
  }
  private async write(dir: FileSystemDirectoryHandle, name: string, value: unknown) {
    const writer = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writer.write(JSON.stringify(value));
    await writer.close();
  }
  async capabilities(): Promise<GenerationCapabilities> {
    try { return parseCapabilities(await this.read(await this.root(), 'capabilities.json')); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new Error('No generation runner is connected to this workspace.');
      }
      throw error;
    }
  }
  async submit(input: GenerationRequest): Promise<void> {
    const request = parseRequest(input);
    const caps = await this.capabilities();
    const capability = caps.stages.find(s => s.stage === request.stage);
    if (!capability?.available) throw new Error(capability?.reason ?? 'This generation tool is unavailable');
    const dir = await this.jobDir(request.id, true);
    try {
      const previous = parseRequest(await this.read(dir, 'request.json'));
      if (!sameRequest(previous, request)) throw new Error('This job ID already belongs to another request');
      return; // Reconnect/replayed submit: keep the original job.
    } catch (e) {
      if (!(e instanceof DOMException) || e.name !== 'NotFoundError') throw e;
    }
    await this.write(dir, 'request.json', request);
  }
  async status(request: GenerationRequest): Promise<GenerationJob> {
    const dir = await this.jobDir(request.id);
    // A cancellation marker wins even if the runner completed just before seeing it.
    try {
      await dir.getFileHandle('cancel.json');
      return { request, state: 'cancelled' };
    } catch (e) {
      if (!(e instanceof DOMException) || e.name !== 'NotFoundError') throw e;
    }
    // A directory can survive a reload before request.json was committed. Let the caller
    // resubmit that same ID instead of displaying an unconsumable queued job forever.
    if (!sameRequest(parseRequest(await this.read(dir, 'request.json')), request)) {
      throw new Error('This job ID already belongs to another request');
    }
    try { return parseJob(await this.read(dir, 'status.json'), request); }
    catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return { request, state: 'queued' };
      throw e;
    }
  }
  async cancel(request: GenerationRequest) {
    await this.write(await this.jobDir(request.id, true), 'cancel.json', { id: request.id });
  }
  async result(job: GenerationJob): Promise<File> {
    if (job.state !== 'completed' || !job.receipt) throw new Error('Generation has not completed');
    parseJob(job, job.request);
    if (job.request.parentId) {
      const parentDir = await this.jobDir(job.request.parentId);
      const parent = parseRequest(await this.read(parentDir, 'request.json'));
      const result = await this.status(parent);
      if (parent.stage !== 'image' || parent.spaceId !== job.request.spaceId
        || result.state !== 'completed' || result.receipt?.output.sha256 !== job.receipt.input.imageSha256) {
        throw new Error('Derivation does not match its source image');
      }
    }
    const file = await (await (await this.jobDir(job.request.id)).getFileHandle(OUTPUT_FILES[job.request.stage])).getFile();
    if (file.size !== job.receipt.output.bytes) throw new Error('Generated file size does not match its receipt');
    await verifyOutput(await file.arrayBuffer(), job.receipt);
    return file;
  }
}
