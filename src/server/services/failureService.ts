import type { FailureRepository } from '../repositories/failureRepository';

export class FailureService {
  constructor(private repository: FailureRepository) {}
  list(offset = 0) {
    return this.repository.list(offset);
  }
  dismiss(id: string) {
    return this.repository.dismiss(id);
  }
  dismissAll() {
    return this.repository.dismissAll();
  }
}
