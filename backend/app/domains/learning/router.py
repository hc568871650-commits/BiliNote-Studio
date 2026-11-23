"""独立学习域路由（/api/learning/*）与旧路径（/api/notes/{task_id}/learning-state）兼容别名。"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.utils.response import ResponseWrapper as R

router = APIRouter(tags=["learning"])


class LearningStateUpdateRequest(BaseModel):
    quiz_attempts: Optional[dict] = None
    pinned_annotations: Optional[dict] = None
    checklist_states: Optional[dict] = None


class ReviewQuizPracticeRequest(BaseModel):
    task_id: str
    section_id: str
    selected_key: Optional[str] = None
    mastered: Optional[bool] = None


class ReviewPitStatusRequest(BaseModel):
    task_id: str
    section_id: str
    annotation_id: str
    mastered: Optional[bool] = None
    remembered: Optional[bool] = None


class UserAnnotationCreateRequest(BaseModel):
    section_id: str = ""
    section_title: str = ""
    block_id: str = ""
    anchor_text: str = ""
    title: str = ""
    detail: str
    source: str = "manual"


class UserAnnotationUpdateRequest(BaseModel):
    section_id: Optional[str] = None
    section_title: Optional[str] = None
    block_id: Optional[str] = None
    anchor_text: Optional[str] = None
    title: Optional[str] = None
    detail: Optional[str] = None


class TopicQuizRequest(BaseModel):
    folder_id: Optional[str] = None
    task_ids: Optional[list[str]] = None
    limit: int = 20
    include_archived: bool = False


def _get_state(task_id: str):
    from app.services import learning_state

    try:
        return R.success(learning_state.get_learning_state(task_id))
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


def _save_state(task_id: str, data: LearningStateUpdateRequest):
    from app.services import learning_state

    try:
        payload = data.model_dump(exclude_none=True)
        return R.success(learning_state.update_learning_state(task_id, payload))
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.get("/learning/notes/{task_id}/state")
@router.get("/notes/{task_id}/learning-state")
def get_note_learning_state(task_id: str):
    return _get_state(task_id)


@router.put("/learning/notes/{task_id}/state")
@router.post("/learning/notes/{task_id}/state")
@router.put("/notes/{task_id}/learning-state")
@router.post("/notes/{task_id}/learning-state")
def save_note_learning_state(task_id: str, data: LearningStateUpdateRequest):
    return _save_state(task_id, data)


@router.get("/learning/review-bank")
def get_learning_review_bank(
    kind: str = "all",
    status: str = "pending",
    limit: int = 100,
    include_archived: bool = False,
):
    from app.services import learning_state

    try:
        return R.success(
            learning_state.query_review_bank(
                kind=kind,
                status=status,
                limit=limit,
                include_archived=include_archived,
            )
        )
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.post("/learning/review-bank/practice")
def submit_review_quiz_practice(data: ReviewQuizPracticeRequest):
    from app.services import learning_state

    try:
        result = learning_state.record_quiz_practice(
            data.task_id,
            data.section_id,
            selected_key=data.selected_key,
            mastered=data.mastered,
        )
        return R.success(result)
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.post("/learning/review-bank/pit-status")
def update_review_pit_status(data: ReviewPitStatusRequest):
    from app.services import learning_state

    try:
        result = learning_state.set_pit_mastered(
            data.task_id,
            data.section_id,
            data.annotation_id,
            mastered=data.mastered,
            remembered=data.remembered,
        )
        return R.success(result)
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.post("/learning/notes/{task_id}/annotations")
@router.post("/notes/{task_id}/annotations")
def create_user_annotation(task_id: str, data: UserAnnotationCreateRequest):
    from app.services import learning_state

    try:
        result = learning_state.add_user_annotation(task_id, data.model_dump())
        return R.success(result)
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.put("/learning/notes/{task_id}/annotations/{annotation_id}")
@router.put("/notes/{task_id}/annotations/{annotation_id}")
def edit_user_annotation(task_id: str, annotation_id: str, data: UserAnnotationUpdateRequest):
    from app.services import learning_state

    try:
        result = learning_state.update_user_annotation(
            task_id,
            annotation_id,
            data.model_dump(exclude_none=True),
        )
        return R.success(result)
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.delete("/learning/notes/{task_id}/annotations/{annotation_id}")
@router.delete("/notes/{task_id}/annotations/{annotation_id}")
def remove_user_annotation(task_id: str, annotation_id: str):
    from app.services import learning_state

    try:
        result = learning_state.delete_user_annotation(task_id, annotation_id)
        return R.success(result)
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.post("/learning/topic-quiz")
def get_topic_quiz(data: TopicQuizRequest):
    from app.services import learning_state

    try:
        result = learning_state.collect_topic_quizzes(
            folder_id=data.folder_id,
            task_ids=data.task_ids,
            limit=data.limit,
            include_archived=data.include_archived,
        )
        return R.success(result)
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.get("/learning/notes/{task_id}/related")
@router.get("/notes/{task_id}/related")
def get_related_notes(task_id: str, limit: int = 3):
    from app.services import related_notes

    try:
        items = related_notes.find_related_notes(task_id, limit=limit)
        return R.success({"items": items})
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)
