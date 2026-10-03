export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}
export interface SkillSource {
  url: string;
  repository: string;
  commit: string;
  folder: string;
}
export interface SkillBundle {
  files: SkillFile[];
  source?: SkillSource;
}
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  version: string;
  fileCount: number;
  bytes: number;
  source: SkillSource | null;
  requirements: string[];
  updatedAt: string;
}
export interface SkillDetail extends SkillInfo {
  files: SkillFile[];
}
