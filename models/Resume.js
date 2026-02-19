import mongoose from 'mongoose';

const resumeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  fileName: {
    type: String,
    required: true,
    trim: true
  },
  fileSize: {
    type: Number,
    required: true
  },
  fileType: {
    type: String,
    enum: ['pdf', 'docx', 'doc'],
    required: true
  },
  rawText: {
    type: String,
    required: true
  },
  parsedData: {
    name: {
      type: String,
      default: ''
    },
    email: {
      type: String,
      default: ''
    },
    phone: {
      type: String,
      default: ''
    },
    summary: {
      type: String,
      default: ''
    },
    skills: [{
      type: String,
      trim: true
    }],
    experience: [{
      title: String,
      company: String,
      location: String,
      duration: String,
      description: String
    }],
    education: [{
      degree: String,
      institution: String,
      year: String,
      description: String
    }],
    certifications: [{
      type: String,
      trim: true
    }],
    languages: [{
      type: String,
      trim: true
    }]
  },
  analysis: {
    yearsOfExperience: {
      type: Number,
      default: 0
    },
    primaryRole: {
      type: String,
      default: ''
    },
    technicalSkills: [{
      type: String,
      trim: true
    }],
    softSkills: [{
      type: String,
      trim: true
    }],
    industries: [{
      type: String,
      trim: true
    }],
    strengths: [{
      type: String,
      trim: true
    }],
    areasForImprovement: [{
      type: String,
      trim: true
    }],
    suggestedInterviewTopics: [{
      type: String,
      trim: true
    }],
    // NEW: Structured extracted data for strict interview question generation
    structuredExperience: [{
      company: {
        type: String,
        trim: true
      },
      jobTitle: {
        type: String,
        trim: true
      },
      duration: {
        type: String,
        trim: true
      },
      keyResponsibilities: [{
        type: String,
        trim: true
      }],
      technologiesUsed: [{
        type: String,
        trim: true
      }],
      achievements: [{
        type: String,
        trim: true
      }]
    }],
    projects: [{
      name: {
        type: String,
        trim: true
      },
      description: {
        type: String,
        trim: true
      },
      technologies: [{
        type: String,
        trim: true
      }],
      yourRole: {
        type: String,
        trim: true
      },
      outcome: {
        type: String,
        trim: true
      }
    }],
    education: [{
      school: {
        type: String,
        trim: true
      },
      degree: {
        type: String,
        trim: true
      },
      field: {
        type: String,
        trim: true
      },
      graduationYear: {
        type: String,
        trim: true
      }
    }],
    achievements: [{
      type: String,
      trim: true
    }]
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastUsed: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
resumeSchema.index({ userId: 1, createdAt: -1 });
resumeSchema.index({ isActive: 1 });

// Virtual for formatted file size
resumeSchema.virtual('fileSizeFormatted').get(function() {
  const kb = this.fileSize / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(2)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
});

// Instance method to get resume summary
resumeSchema.methods.getSummary = function() {
  return {
    id: this._id,
    fileName: this.fileName,
    fileSize: this.fileSizeFormatted,
    uploadedAt: this.createdAt,
    primaryRole: this.analysis.primaryRole,
    yearsOfExperience: this.analysis.yearsOfExperience,
    skills: this.parsedData.skills
  };
};

// Static method to find active resumes by user
resumeSchema.statics.findActiveByUser = function(userId) {
  return this.find({ userId, isActive: true })
    .sort({ lastUsed: -1 })
    .limit(10);
};

// Static method to get latest resume for user
resumeSchema.statics.getLatestForUser = function(userId) {
  return this.findOne({ userId, isActive: true })
    .sort({ createdAt: -1 });
};

const Resume = mongoose.model('Resume', resumeSchema);

export default Resume;

