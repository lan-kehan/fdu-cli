import { z } from 'zod';
import { FduError } from '../core/errors';
import { canvasId as id, readCanvas } from './elearning-content';

const text = z.string().nullish();
const num = z.number().nullish();
const bool = z.boolean().nullish();
const enrollmentSchema = z.object({
  course_id: id,
  grades: z.object({ html_url: text, current_score: num, final_score: num, current_grade: text, final_grade: text }).nullish(),
});
const groupSchema = z.object({
  id, name: z.string(), position: num, group_weight: num,
  rules: z.object({ drop_lowest: num, drop_highest: num }).nullish(),
  assignments: z.array(z.object({
    id, name: z.string(), due_at: text, points_possible: num, html_url: text,
    grading_type: text, omit_from_final_grade: bool,
    submission: z.object({
      score: num, grade: text, workflow_state: text, submitted_at: text, graded_at: text,
      excused: bool, late: bool, missing: bool,
    }).nullish(),
    score_statistics: z.object({ min: num, max: num, mean: num }).nullish(),
  })).nullish(),
});
const formatError = () => new FduError('FORMAT_CHANGED', 'eLearning 成绩数据格式异常。', '请在课程网页的「成绩」里核对；向开发者反馈错误信息，不要附上成绩或登录凭证。');

/** 一门课的总评。分数为 null 表示老师没有开放总评或还没有评分，不是零分。 */
export interface CourseTotals {
  /** 是否以学生身份加入这门课（助教、旁听没有成绩） */
  asStudent: boolean;
  /** 只算已评分作业的百分制得分 */
  currentScore: number | null;
  currentGrade: string | null;
  /** 把没交、没评分的作业按零分计入的百分制得分 */
  finalScore: number | null;
  finalGrade: string | null;
  htmlUrl: string | null;
}
export const NO_TOTALS: CourseTotals = { asStudent: false, currentScore: null, currentGrade: null, finalScore: null, finalGrade: null, htmlUrl: null };

/** 本人各门课的学生注册记录 → 课程 id 到总评。同一门课有多条注册时取带分数的一条。 */
export function parseEnrollmentGrades(data: unknown): Map<string, CourseTotals> {
  const parsed = z.array(enrollmentSchema).safeParse(data);
  if (!parsed.success) throw formatError();
  const out = new Map<string, CourseTotals>();
  for (const e of parsed.data) {
    const g = e.grades;
    const totals: CourseTotals = {
      asStudent: true, currentScore: g?.current_score ?? null, currentGrade: g?.current_grade ?? null,
      finalScore: g?.final_score ?? null, finalGrade: g?.final_grade ?? null, htmlUrl: g?.html_url ?? null,
    };
    const had = out.get(e.course_id);
    if (!had || (had.currentScore === null && had.finalScore === null)) out.set(e.course_id, totals);
  }
  return out;
}

export function parseGradeGroups(data: unknown) {
  const parsed = z.array(groupSchema).safeParse(data);
  if (!parsed.success) throw formatError();
  return parsed.data.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((g) => ({
    id: g.id, name: g.name,
    /** 占总评的百分比；课程没有按作业组加权时没有意义（见 weighted） */
    weight: g.group_weight ?? null,
    dropLowest: g.rules?.drop_lowest ?? null, dropHighest: g.rules?.drop_highest ?? null,
    assignments: (g.assignments ?? []).map((a) => ({
      id: a.id, name: a.name, dueAt: a.due_at ?? null, htmlUrl: a.html_url ?? null,
      pointsPossible: a.points_possible ?? null, gradingType: a.grading_type ?? null,
      omitFromFinalGrade: a.omit_from_final_grade ?? null,
      /** null 表示还没评分或分数未公布，不是零分 */
      score: a.submission?.score ?? null, grade: a.submission?.grade ?? null,
      state: a.submission?.workflow_state ?? null, submittedAt: a.submission?.submitted_at ?? null, gradedAt: a.submission?.graded_at ?? null,
      excused: a.submission?.excused ?? null, late: a.submission?.late ?? null, missing: a.submission?.missing ?? null,
      /** 全班的最低、最高、平均分；老师没有开放时为 null */
      stats: a.score_statistics ? { min: a.score_statistics.min ?? null, max: a.score_statistics.max ?? null, mean: a.score_statistics.mean ?? null } : null,
    })),
  }));
}
export type CanvasGradeGroup = ReturnType<typeof parseGradeGroups>[number];
export interface CanvasCourseGrades {
  /** 总评是否按作业组权重计算；null 表示接口未返回 */
  weighted: boolean | null;
  groups: CanvasGradeGroup[];
}

export const readGradeData = <T>(read: () => Promise<T>) => readCanvas({
  denied: ['没有权限查看这门课的成绩。', '在 eLearning 课程网页确认「成绩」栏目对学生开放。'],
  missing: ['没有找到这门课的成绩。', '用 `fdu elearning courses` 核对课程 id。'],
  format: formatError,
}, read);
