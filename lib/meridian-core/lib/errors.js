'use strict';

class MeridianError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MeridianError';
    this.code = code;
  }
}

class ValidationError extends MeridianError {
  constructor(message, errors = []) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

class EntryNotFoundError extends MeridianError {
  constructor(project, entryId) {
    super(`Entry "${entryId}" not found in project "${project}"`, 'ENTRY_NOT_FOUND');
    this.name = 'EntryNotFoundError';
    this.project = project;
    this.entryId = entryId;
  }
}

class DuplicateEntryError extends MeridianError {
  constructor(project, entryId) {
    super(`Entry "${entryId}" already exists in project "${project}"`, 'DUPLICATE_ENTRY');
    this.name = 'DuplicateEntryError';
    this.project = project;
    this.entryId = entryId;
  }
}

class ProjectNotFoundError extends MeridianError {
  constructor(projectId) {
    super(`Project "${projectId}" not found`, 'PROJECT_NOT_FOUND');
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

module.exports = { MeridianError, ValidationError, EntryNotFoundError, DuplicateEntryError, ProjectNotFoundError };
