# AceAi Backend - AI Interview Platform API

Backend server for AceAi, an AI-powered interview preparation platform with voice capabilities, resume analysis, and intelligent question generation.

## 🚀 Features

### Core Functionality
- **AI Interview Engine** - GPT-4o-mini powered interview sessions with multiple modes (Friendly, Moderate, Strict)
- **Voice Interview** - Real-time voice transcription and text-to-speech using Deepgram
- **Resume Analysis** - Intelligent parsing and analysis of PDF/DOC/DOCX resumes
- **Batch Question Generation** - Pre-fetch 3 questions at once for reduced latency
- **WebSocket Streaming** - Ultra-low latency voice streaming (experimental)

### User Management
- **JWT Authentication** - Secure token-based authentication
- **Google OAuth** - Social login integration
- **Plan-based Access** - STARTER (20 questions, 30 min) / VALUE (35 questions, 50 min)
- **Payment Integration** - Razorpay for plan subscriptions

### Interview Features
- **Resume-based Questions** - Questions prioritize core skills from uploaded resume
- **Conversation Context** - Full conversation history for contextual questions
- **Real-time Feedback** - Instant AI-generated feedback after each answer
- **Interview History** - Persistent chat storage in MongoDB
- 📊 **Statistics** - User performance tracking and analytics
- 🗄️ **MongoDB** - Scalable NoSQL database with Mongoose ODM

## 🛠️ Tech Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js
- **Database:** MongoDB (Mongoose ODM)
- **AI/ML:** OpenAI GPT-4o-mini, Groq (alternative LLM provider)
- **Voice:** Deepgram (STT/TTS)
- **Authentication:** JWT, Google OAuth
- **Payments:** Razorpay
- **WebSocket:** ws library for real-time voice streaming

## 📋 Prerequisites

- Node.js 18+ and npm
- MongoDB Atlas account (or local MongoDB)
- OpenAI API key or Groq API key
- Deepgram API key
- Google OAuth credentials
- Razorpay account (for payments)

## ⚙️ Environment Variables

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Database
MONGODB_URI=mongodb+srv://your-username:password@cluster.mongodb.net/

# JWT Authentication
JWT_SECRET=your-super-secret-key-here
JWT_EXPIRES_IN=7d

# CORS
FRONTEND_URL=http://localhost:5173

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# AI Provider (choose one)
AI_PROVIDER=openai  # or 'groq'
OPENAI_API_KEY=sk-proj-your-openai-api-key
GROQ_API_KEY=gsk_your-groq-api-key
GROQ_BASE_URL=https://api.groq.com

# Voice Services
DEEPGRAM_API_KEY=your-deepgram-api-key

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com

# Payment Gateway
RAZORPAY_KEY_ID=rzp_test_your-key-id
RAZORPAY_KEY_SECRET=your-razorpay-secret

# Email (Optional)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
ADMIN_EMAIL=admin@example.com
```

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone <backend-repo-url>
   cd Backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   # Create .env file with above variables
   # NEVER commit .env to git!
   ```

4. **Run database setup (optional)**
   ```bash
   npm run setup
   ```

## 🚀 Running the Server

### Development Mode (with auto-reload)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on `http://localhost:5000`

## 📁 Project Structure

```
Backend/
├── config/
│   └── database.js           # MongoDB connection
├── models/
│   ├── User.js              # User schema with plans
│   ├── Chat.js              # Interview chat sessions
│   ├── Message.js           # Chat messages
│   └── Resume.js            # Resume analysis data
├── routes/
│   ├── auth.js              # Authentication endpoints
│   ├── users.js             # User management
│   ├── chats.js             # Chat CRUD operations
│   ├── ai.js                # AI interview logic (MAIN)
│   ├── resumes.js           # Resume upload & analysis
│   ├── payments.js          # Payment processing
│   ├── feedback.js          # Feedback collection
│   └── voiceStream.js       # WebSocket voice streaming
├── middleware/
│   ├── auth.js              # JWT verification
│   └── errorHandler.js      # Global error handling
├── services/
│   └── llmProvider.js       # AI provider abstraction
├── server.js                # Main entry point
└── package.json            # Dependencies
```

## 🔌 API Endpoints

### Authentication
- `POST /api/auth/register` - Create new account
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/google` - Google OAuth login
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/profile` - Update profile
- `PUT /api/auth/change-password` - Change password

### Interviews (AI Routes)
- `POST /api/ai/interview` - Get AI interview question (supports batch generation)
- `POST /api/ai/initial-question/:mode` - Get first question
- `POST /api/ai/transcribe` - Transcribe audio to text
- `POST /api/ai/tts` - Text-to-speech synthesis
- `POST /api/ai/generate-interview-feedback` - Generate interview feedback
- `POST /api/ai/voice-round` - Voice interview round

### Chats
- `GET /api/chats` - Get user's chat history
- `POST /api/chats` - Create new chat session
- `GET /api/chats/:id` - Get chat details
- `GET /api/chats/:id/messages` - Get chat messages
- `POST /api/chats/:id/messages` - Add message to chat
- `DELETE /api/chats/:id` - Delete chat

### Resumes
- `POST /api/resumes/upload` - Upload and analyze resume (PDF/DOC/DOCX)
- `GET /api/resumes` - Get user's resumes
- `GET /api/resumes/:id` - Get resume details
- `DELETE /api/resumes/:id` - Delete resume

### Payments
- `GET /api/payments/plans` - Get available plans
- `POST /api/payments/create-order` - Create Razorpay order
- `POST /api/payments/verify` - Verify payment
- `POST /api/payments/consume-starter` - Consume starter credit

### Feedback
- `POST /api/feedback` - Submit user feedback

### Health Check
- `GET /api/health` - Server health status

## 🎯 Key Features Explained

### Batch Question Generation
Request multiple questions at once to reduce latency:

```javascript
// Request
{
  "userAnswer": "I have 3 years of React experience...",
  "batchCount": 3,
  "interviewMode": "moderate",
  "resumeId": "...",
  "conversation": [...]
}

// Response
{
  "status": "success",
  "data": {
    "response": "First question text?",
    "responses": [
      "First question text?",
      "Second question text?",
      "Third question text?"
    ]
  }
}
```

### Resume-Based Interviews
1. Upload PDF/DOC resume → parsed and analyzed
2. AI extracts: skills, projects, experience, education
3. Questions prioritize core skills from resume
4. References specific projects and experiences

### Plan Limits (Server-Enforced)
- **STARTER**: 20 questions, 30 minutes, job-focused only
- **VALUE**: 35 questions, 50 minutes, resume-based questions

## 🔒 Security

- ✅ Helmet.js security headers
- ✅ Rate limiting (100 req/15 min per IP)
- ✅ JWT token expiration (7 days)
- ✅ Password hashing with bcrypt
- ✅ Input validation
- ✅ CORS configured
- ✅ Environment variables for secrets
- ✅ MongoDB injection prevention

## 🐛 Debugging

Enable detailed logs with `NODE_ENV=development`:
```bash
npm run dev
```

Console output includes:
- 🔍 Batch question generation steps
- 📊 Resume analysis details  
- 🤖 LLM request/response logs
- 🔌 WebSocket connection events

## 🚀 Deployment

### Railway (Recommended)
1. Create new project
2. Add MongoDB plugin
3. Set environment variables
4. Connect GitHub repo
5. Deploy

### Render
1. Create Web Service
2. Build: `npm install`
3. Start: `npm start`
4. Add environment variables
5. Deploy

### Important: Update CORS
Set `FRONTEND_URL` to your deployed frontend domain!

## 📝 Environment Variables Checklist

Before deployment, ensure you have:
- ✅ MongoDB URI (Atlas recommended)
- ✅ JWT_SECRET (generate random 64-char string)
- ✅ OpenAI or Groq API key
- ✅ Deepgram API key
- ✅ Google OAuth credentials
- ✅ Razorpay keys (test or live)
- ✅ FRONTEND_URL (deployed frontend domain)

## ⚠️ IMPORTANT: Never Commit

The `.gitignore` file blocks these from being committed:
- ❌ `.env` file with secrets
- ❌ `node_modules/`
- ❌ API keys and credentials
- ❌ Database credentials
- ❌ SSL certificates

**Double-check before pushing to GitHub!**

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Open Pull Request

## 📜 License

MIT License

## 🔗 Related

- **Frontend Repository:** [Link to frontend repo]

---

Built with ❤️ for AceAi Interview Platform
| GET | `/api/chats/public` | Get public chats | Admin |
| PUT | `/api/chats/:id/visibility` | Toggle chat visibility | Private |

## Request/Response Examples

### User Registration

```bash
POST /api/auth/register
Content-Type: application/json

{
  "username": "john_doe",
  "email": "john@example.com",
  "password": "SecurePass123",
  "firstName": "John",
  "lastName": "Doe"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": "60f7b3b3b3b3b3b3b3b3b3b3",
      "username": "john_doe",
      "email": "john@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "fullName": "John Doe",
      "profilePicture": "",
      "isActive": true,
      "role": "user",
      "createdAt": "2024-01-15T10:30:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### Create Chat

```bash
POST /api/chats
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Technical Interview - Frontend",
  "description": "React and JavaScript focused interview",
  "interviewType": "technical",
  "difficulty": "intermediate",
  "tags": ["react", "javascript", "frontend"]
}
```

### Add Message

```bash
POST /api/chats/:chatId/messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "role": "user",
  "content": "Tell me about React hooks",
  "metadata": {
    "questionType": "technical"
  }
}
```

## Database Schema

### User Model
```javascript
{
  username: String (unique),
  email: String (unique),
  password: String (hashed),
  firstName: String,
  lastName: String,
  profilePicture: String,
  isActive: Boolean,
  lastLogin: Date,
  role: String (enum: ['user', 'admin']),
  timestamps: true
}
```

### Chat Model
```javascript
{
  userId: ObjectId (ref: User),
  title: String,
  description: String,
  messages: [{
    role: String (enum: ['user', 'assistant']),
    content: String,
    timestamp: Date,
    metadata: Map
  }],
  status: String (enum: ['active', 'completed', 'archived']),
  interviewType: String (enum: ['technical', 'behavioral', 'general', 'custom']),
  difficulty: String (enum: ['beginner', 'intermediate', 'advanced', 'expert']),
  duration: Number,
  score: Number,
  feedback: String,
  tags: [String],
  settings: Map,
  isPublic: Boolean,
  lastActivity: Date,
  timestamps: true
}
```

## Error Handling

The API returns consistent error responses:

```json
{
  "status": "error",
  "message": "Error description",
  "errors": [
    {
      "field": "email",
      "message": "Please provide a valid email address",
      "value": "invalid-email"
    }
  ]
}
```

## Security Features

- **JWT Authentication**: Secure token-based authentication
- **Password Hashing**: bcryptjs with salt rounds
- **Input Validation**: express-validator for all inputs
- **Rate Limiting**: Prevent abuse with express-rate-limit
- **CORS**: Configured for frontend integration
- **Helmet**: Security headers
- **Error Handling**: Centralized error handling middleware

## Development

### Scripts
```bash
npm run dev    # Start development server with nodemon
npm start      # Start production server
npm test       # Run tests (to be implemented)
```

### Environment Variables
- `PORT`: Server port (default: 5000)
- `NODE_ENV`: Environment (development/production)
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret key for JWT tokens
- `JWT_EXPIRES_IN`: Token expiration time
- `FRONTEND_URL`: Frontend URL for CORS
- `RATE_LIMIT_WINDOW_MS`: Rate limiting window
- `RATE_LIMIT_MAX_REQUESTS`: Max requests per window

## Deployment

1. **Set environment variables** for production
2. **Update MongoDB URI** to production database
3. **Change JWT_SECRET** to a strong secret
4. **Set NODE_ENV=production**
5. **Deploy to your preferred platform** (Heroku, Vercel, AWS, etc.)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC License 