import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  Canvas,
  useFrame,
  useLoader,
  useThree,
} from "@react-three/fiber";
import {
  OrbitControls,
  Sparkles,
  Stars,
} from "@react-three/drei";

import "./index.css";

const LM_STUDIO = "http://127.0.0.1:1234";

const earthTextureUrl =
  "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg";

const normalTextureUrl =
  "https://threejs.org/examples/textures/planets/earth_normal_2048.jpg";

/* =========================================================
   LOCAL STORAGE HELPERS
========================================================= */

function loadJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
}

/* =========================================================
   LM STUDIO
========================================================= */

async function getLMStudioModel() {
  const response = await fetch(`${LM_STUDIO}/v1/models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `LM Studio server error (${response.status}). ${raw.slice(0, 300)}`
    );
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("LM Studio returned invalid JSON.");
  }

  const models = Array.isArray(data?.data) ? data.data : [];

  if (!models.length) {
    throw new Error(
      "LM Studio is running, but there is no model loaded. Load your Gemma model first."
    );
  }

  return models[0]?.id;
}

async function askLMStudio(messages, temperature = 0.2, maxTokens = null, jsonMode = false) {
  const model = await getLMStudioModel();

  const response = await fetch(`${LM_STUDIO}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(jsonMode ? {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "nova_quiz_response",
            strict: true,
            schema: {
              type: "object",
              properties: {
                questions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      question: { type: "string" },
                      options: { type: "array", items: { type: "string" } },
                      answer: { type: "integer" }
                    },
                    required: ["question", "options", "answer"],
                    additionalProperties: false
                  }
                }
              },
              required: ["questions"],
              additionalProperties: false
            }
          }
        }
      } : {}),
      stream: false,
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `LM Studio rejected the request (${response.status}). ${raw.slice(
        0,
        500
      )}`
    );
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Nova received an invalid JSON response from LM Studio."
    );
  }

  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LM Studio returned an empty AI response.");
  }

  return content.trim();
}

/* =========================================================
   ROBUST JSON OBJECT PARSER
========================================================= */

function extractFirstJSONObject(text) {
  if (!text) return null;

  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue below
  }

  const firstBrace = cleaned.indexOf("{");

  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let i = firstBrace; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        insideString = false;
      }

      continue;
    }

    if (char === '"') {
      insideString = true;
      continue;
    }

    if (char === "{") {
      depth++;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        const possible = cleaned.slice(firstBrace, i + 1);

        try {
          return JSON.parse(possible);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}


function extractFirstJSONArray(text) {
  if (!text) return null;

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
    if (Array.isArray(direct?.questions)) return direct.questions;
  } catch {
    // The model may have included a short preamble; locate the JSON array.
  }

  const start = cleaned.indexOf("[");
  if (start < 0) {
    const object = extractFirstJSONObject(cleaned);
    if (Array.isArray(object?.questions)) return object.questions;
    return null;
  }

  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (insideString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') insideString = false;
      continue;
    }

    if (char === '"') insideString = true;
    else if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function normalizeQuizQuestion(data, type) {
  if (!data) return null;

  let question = data;

  if (Array.isArray(data?.questions)) {
    question = data.questions[0];
  }

  if (!question || typeof question !== "object") {
    return null;
  }

  const questionText =
    typeof question.question === "string"
      ? question.question.trim()
      : "";

  if (!questionText) {
    return null;
  }

  let options = Array.isArray(question.options)
    ? question.options
        .filter((x) => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  let answer = question.answer;

  if (type === "mcq") {
    if (options.length < 4) {
      return null;
    }

    options = options.slice(0, 4);

    if (typeof answer === "string") {
      const upper = answer.trim().toUpperCase();

      if (["A", "B", "C", "D"].includes(upper)) {
        answer = ["A", "B", "C", "D"].indexOf(upper);
      } else {
        const parsed = Number(answer);

        if (Number.isFinite(parsed)) {
          answer = parsed > 3 ? parsed - 1 : parsed;
        }
      }
    }

    answer = Number(answer);

    if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
      return null;
    }

    return {
      question: questionText,
      options,
      answer,
      type: "mcq",
    };
  }

  // TRUE / FALSE
  options = ["True", "False"];

  if (typeof answer === "string") {
    const lower = answer.trim().toLowerCase();

    if (lower === "true") {
      answer = 0;
    } else if (lower === "false") {
      answer = 1;
    } else {
      const parsed = Number(answer);

      if (Number.isFinite(parsed)) {
        answer = parsed > 1 ? parsed - 1 : parsed;
      }
    }
  }

  answer = Number(answer);

  if (!Number.isInteger(answer) || answer < 0 || answer > 1) {
    return null;
  }

  return {
    question: questionText,
    options,
    answer,
    type: "tf",
  };
}

/* =========================================================
   EARTH
========================================================= */

function CursorEarthMovement({ children }) {
  const group = useRef();
  const { pointer } = useThree();

  useFrame((_, delta) => {
    if (!group.current) return;

    const targetX = pointer.y * 0.15;
    const targetZ = -pointer.x * 0.15;

    group.current.rotation.x = THREE.MathUtils.lerp(
      group.current.rotation.x,
      targetX,
      1 - Math.exp(-delta * 3)
    );

    group.current.rotation.z = THREE.MathUtils.lerp(
      group.current.rotation.z,
      targetZ,
      1 - Math.exp(-delta * 3)
    );
  });

  return <group ref={group}>{children}</group>;
}

function Earth() {
  const earthRef = useRef();

  const earthTexture = useLoader(
    THREE.TextureLoader,
    earthTextureUrl
  );

  const normalTexture = useLoader(
    THREE.TextureLoader,
    normalTextureUrl
  );

  useFrame((_, delta) => {
    if (earthRef.current) {
      earthRef.current.rotation.y += delta * 0.075;
    }
  });

  return (
    <group>
      <CursorEarthMovement>
        <group ref={earthRef}>
          <mesh>
            <sphereGeometry args={[2, 64, 64]} />

            <meshStandardMaterial
              map={earthTexture}
              normalMap={normalTexture}
              normalScale={new THREE.Vector2(0.35, 0.35)}
              roughness={0.58}
              metalness={0.03}
            />
          </mesh>

          {/* Atmosphere */}
          <mesh scale={1.035}>
            <sphereGeometry args={[2, 64, 64]} />

            <meshBasicMaterial
              color="#159dff"
              transparent
              opacity={0.14}
              side={THREE.BackSide}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          <mesh scale={1.08}>
            <sphereGeometry args={[2, 64, 64]} />

            <meshBasicMaterial
              color="#0077ff"
              transparent
              opacity={0.06}
              side={THREE.BackSide}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>
      </CursorEarthMovement>

      {/* Orbit rings */}
      <mesh rotation={[Math.PI / 2.8, 0.2, 0]}>
        <torusGeometry args={[2.75, 0.018, 16, 160]} />

        <meshBasicMaterial
          color="#168cff"
          transparent
          opacity={0.8}
        />
      </mesh>

      <mesh rotation={[Math.PI / 2.2, -0.5, 0.3]}>
        <torusGeometry args={[3.2, 0.012, 16, 160]} />

        <meshBasicMaterial
          color="#55baff"
          transparent
          opacity={0.65}
        />
      </mesh>

      <mesh rotation={[0.8, 0.2, 1]}>
        <torusGeometry args={[3.7, 0.008, 16, 160]} />

        <meshBasicMaterial
          color="#008cff"
          transparent
          opacity={0.55}
        />
      </mesh>

      {/* Satellites */}
      <mesh position={[3.05, 0.2, 0]}>
        <boxGeometry args={[0.13, 0.13, 0.13]} />

        <meshStandardMaterial
          color="#dcecff"
          emissive="#008cff"
          emissiveIntensity={2}
        />
      </mesh>

      <mesh position={[-3.2, -0.4, 0]}>
        <boxGeometry args={[0.1, 0.1, 0.1]} />

        <meshStandardMaterial
          color="#dcecff"
          emissive="#168cff"
          emissiveIntensity={2}
        />
      </mesh>
    </group>
  );
}

function EarthScene() {
  return (
    <Canvas
      camera={{
        position: [0, 0, 6.5],
        fov: 45,
      }}
      style={{
        width: "100%",
        height: "100%",
      }}
    >
      <ambientLight intensity={0.55} />

      <directionalLight
        position={[5, 4, 5]}
        intensity={2.8}
      />

      <pointLight
        position={[-5, -2, 4]}
        intensity={2.5}
        color="#008cff"
      />

      <Stars
        radius={80}
        depth={50}
        count={5000}
        factor={3}
        fade
        speed={0.2}
      />

      <Sparkles
        count={100}
        scale={[10, 8, 10]}
        size={1.5}
        speed={0.15}
        color="#55baff"
      />

      <Earth />

      <OrbitControls
        enablePan={false}
        enableRotate
        enableZoom
        enableDamping
        dampingFactor={0.06}
        rotateSpeed={0.55}
        zoomSpeed={0.7}
        minDistance={4.5}
        maxDistance={9}
      />
    </Canvas>
  );
}

/* =========================================================
   SHARED UI
========================================================= */

function PageHeader({ title, subtitle }) {
  return (
    <div className="pageHeader">
      <div>
        <div className="eyebrow">NOVA SYSTEM</div>

        <h1>{title}</h1>

        {subtitle && <p>{subtitle}</p>}
      </div>
    </div>
  );
}

function StatusDot({ online }) {
  return (
    <span
      className={`statusDot ${online ? "online" : "offline"}`}
    />
  );
}

/* =========================================================
   HOME
========================================================= */

function Home({
  setPage,
  lmStatus,
}) {
  return (
    <div className="homePage">
      <div className="homeTop">
        <div>
          <div className="novaLogo">
            <span className="novaOrb" />
            NOVA
          </div>

          <div className="localText">
            LOCAL INTELLIGENCE
          </div>
        </div>

        <div className="homeStatus">
          <StatusDot online={lmStatus.connected} />

          {lmStatus.connected
            ? "LM STUDIO ONLINE"
            : "LOCAL AI OFFLINE"}
        </div>
      </div>

      <div className="earthArea">
        <div className="earthGlow" />

        <div className="earthCanvas">
          <EarthScene />
        </div>

        <div className="earthText">
          <div className="smallLabel">
            PERSONAL AI SYSTEM
          </div>

          <h1>
            Meet
            <br />
            <span>NOVA</span>
          </h1>

          <p>
            Your local intelligence layer for school,
            planning, conversations, safety and everyday
            decisions.
          </p>

          <button
            className="primaryButton"
            onClick={() => setPage("talk")}
          >
            TALK TO NOVA
          </button>
        </div>
      </div>

      <div className="earthControls">
        <button
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("nova-earth-zoom", {
                detail: "in",
              })
            );
          }}
        >
          +
        </button>

        <button
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("nova-earth-zoom", {
                detail: "out",
              })
            );
          }}
        >
          −
        </button>
      </div>
    </div>
  );
}

/* =========================================================
   DASHBOARD
========================================================= */

function Dashboard({ lmStatus }) {
  const transactions = loadJSON(
    "nova_transactions",
    []
  );

  const timetable = loadJSON(
    "nova_timetable",
    []
  );

  const reminders = loadJSON(
    "nova_reminders",
    []
  );

  const income = transactions
    .filter((x) => x.type === "income")
    .reduce((sum, x) => sum + Number(x.amount || 0), 0);

  const expenses = transactions
    .filter((x) => x.type === "expense")
    .reduce((sum, x) => sum + Number(x.amount || 0), 0);

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle="Your Nova command center."
      />

      <div className="dashboardGrid">
        <div className="dashCard large">
          <span>AI STATUS</span>

          <strong>
            <StatusDot online={lmStatus.connected} />

            {lmStatus.connected
              ? "ONLINE"
              : "OFFLINE"}
          </strong>

          <small>
            {lmStatus.model || "No model detected"}
          </small>
        </div>

        <div className="dashCard">
          <span>INCOME</span>
          <strong>K {income.toFixed(2)}</strong>
        </div>

        <div className="dashCard">
          <span>EXPENSES</span>
          <strong>K {expenses.toFixed(2)}</strong>
        </div>

        <div className="dashCard">
          <span>TIMETABLE</span>
          <strong>{timetable.length}</strong>
          <small>saved entries</small>
        </div>

        <div className="dashCard">
          <span>REMINDERS</span>
          <strong>{reminders.length}</strong>
          <small>saved reminders</small>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   TIMETABLE
========================================================= */

function Timetable() {
  const [items, setItems] = useState(() =>
    loadJSON("nova_timetable", [])
  );

  const [subject, setSubject] = useState("");
  const [day, setDay] = useState("Monday");
  const [time, setTime] = useState("");

  useEffect(() => {
    saveJSON("nova_timetable", items);
  }, [items]);

  function addItem() {
    if (!subject.trim() || !time) return;

    setItems((prev) => [
      ...prev,
      {
        id: Date.now(),
        subject: subject.trim(),
        day,
        time,
      },
    ]);

    setSubject("");
    setTime("");
  }

  function deleteItem(id) {
    setItems((prev) =>
      prev.filter((item) => item.id !== id)
    );
  }

  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];

  return (
    <div className="page">
      <PageHeader
        title="Timetable"
        subtitle="Keep your academic schedule inside Nova."
      />

      <div className="twoColumn">
        <div className="panel">
          <h2>Add class</h2>

          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
          />

          <select
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            {days.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>

          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />

          <button
            className="primaryButton full"
            onClick={addItem}
          >
            ADD TO TIMETABLE
          </button>
        </div>

        <div className="panel">
          <h2>Your timetable</h2>

          {items.length === 0 ? (
            <div className="empty">
              No classes added yet.
            </div>
          ) : (
            <div className="list">
              {items.map((item) => (
                <div className="listItem" key={item.id}>
                  <div>
                    <strong>{item.subject}</strong>

                    <small>
                      {item.day} · {item.time}
                    </small>
                  </div>

                  <button
                    className="dangerButton"
                    onClick={() =>
                      deleteItem(item.id)
                    }
                  >
                    DELETE
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   REMINDERS
========================================================= */

function Reminders() {
  const [items, setItems] = useState(() =>
    loadJSON("nova_reminders", [])
  );

  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  useEffect(() => {
    saveJSON("nova_reminders", items);
  }, [items]);

  function addReminder() {
    if (!text.trim() || !date || !time) return;

    setItems((prev) => [
      ...prev,
      {
        id: Date.now(),
        text: text.trim(),
        date,
        time,
      },
    ]);

    setText("");
    setDate("");
    setTime("");
  }

  function deleteReminder(id) {
    setItems((prev) =>
      prev.filter((item) => item.id !== id)
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Reminders"
        subtitle="Never leave important things floating around in your head."
      />

      <div className="twoColumn">
        <div className="panel">
          <h2>New reminder</h2>

          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What should Nova remind you about?"
          />

          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />

          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />

          <button
            className="primaryButton full"
            onClick={addReminder}
          >
            SAVE REMINDER
          </button>
        </div>

        <div className="panel">
          <h2>Saved reminders</h2>

          {items.length === 0 ? (
            <div className="empty">
              No reminders yet.
            </div>
          ) : (
            <div className="list">
              {items.map((item) => (
                <div className="listItem" key={item.id}>
                  <div>
                    <strong>{item.text}</strong>

                    <small>
                      {item.date} · {item.time}
                    </small>
                  </div>

                  <button
                    className="dangerButton"
                    onClick={() =>
                      deleteReminder(item.id)
                    }
                  >
                    DELETE
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   BUDGET
========================================================= */

function Budget() {
  const [transactions, setTransactions] =
    useState(() =>
      loadJSON("nova_transactions", [])
    );

  const [savings, setSavings] = useState(() =>
    Number(localStorage.getItem("nova_savings") || 0)
  );

  const [type, setType] = useState("expense");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    saveJSON("nova_transactions", transactions);
  }, [transactions]);

  useEffect(() => {
    localStorage.setItem(
      "nova_savings",
      String(savings)
    );
  }, [savings]);

  const income = useMemo(
    () =>
      transactions
        .filter((x) => x.type === "income")
        .reduce(
          (sum, x) => sum + Number(x.amount || 0),
          0
        ),
    [transactions]
  );

  const expenses = useMemo(
    () =>
      transactions
        .filter((x) => x.type === "expense")
        .reduce(
          (sum, x) => sum + Number(x.amount || 0),
          0
        ),
    [transactions]
  );

  const balance = income - expenses;
  const available = balance - savings;

  function addTransaction() {
    const numericAmount = Number(amount);

    if (
      !description.trim() ||
      !numericAmount ||
      numericAmount <= 0
    ) {
      return;
    }

    setTransactions((prev) => [
      ...prev,
      {
        id: Date.now(),
        type,
        description: description.trim(),
        amount: numericAmount,
      },
    ]);

    setDescription("");
    setAmount("");
  }

  function deleteTransaction(id) {
    setTransactions((prev) =>
      prev.filter((x) => x.id !== id)
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Budget Mode"
        subtitle="Nova calculates your money with you."
      />

      <div className="moneyGrid">
        <div className="moneyCard">
          <span>INCOME</span>
          <strong>K {income.toFixed(2)}</strong>
        </div>

        <div className="moneyCard">
          <span>EXPENSES</span>
          <strong>K {expenses.toFixed(2)}</strong>
        </div>

        <div className="moneyCard">
          <span>BALANCE</span>
          <strong>K {balance.toFixed(2)}</strong>
        </div>

        <div className="moneyCard">
          <span>AVAILABLE</span>
          <strong>K {available.toFixed(2)}</strong>
        </div>
      </div>

      <div className="twoColumn">
        <div className="panel">
          <h2>Add transaction</h2>

          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>

          <input
            value={description}
            onChange={(e) =>
              setDescription(e.target.value)
            }
            placeholder="Description"
          />

          <input
            type="number"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount in K"
          />

          <button
            className="primaryButton full"
            onClick={addTransaction}
          >
            ADD TRANSACTION
          </button>

          <div className="savingsBox">
            <label>Savings target</label>

            <input
              type="number"
              min="0"
              value={savings}
              onChange={(e) =>
                setSavings(Number(e.target.value))
              }
            />
          </div>
        </div>

        <div className="panel">
          <h2>Transactions</h2>

          {transactions.length === 0 ? (
            <div className="empty">
              No transactions yet.
            </div>
          ) : (
            <div className="list">
              {transactions.map((item) => (
                <div
                  className="listItem"
                  key={item.id}
                >
                  <div>
                    <strong>
                      {item.description}
                    </strong>

                    <small>
                      {item.type === "income"
                        ? "Income"
                        : "Expense"}
                    </small>
                  </div>

                  <div className="transactionRight">
                    <strong>
                      K {Number(item.amount).toFixed(2)}
                    </strong>

                    <button
                      className="dangerButton"
                      onClick={() =>
                        deleteTransaction(item.id)
                      }
                    >
                      DELETE
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   SCHOOL
========================================================= */

function School() {
  const [material, setMaterial] = useState("");
  const [fileName, setFileName] = useState("");
  const [questionCount, setQuestionCount] = useState(5);
  const [questionType, setQuestionType] = useState("mcq");
  const [quiz, setQuiz] = useState([]);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [lmMessage, setLmMessage] = useState("");
  const [error, setError] = useState("");
  const [generationProgress, setGenerationProgress] = useState("");

  async function testLMStudio() {
    setTestLoading(true);
    setError("");
    setLmMessage("");
    try {
      const model = await getLMStudioModel();
      setLmMessage(`CONNECTED ✓ Model detected: ${model}`);
    } catch (err) {
      setError(err?.message || "Nova could not connect to LM Studio.");
    } finally {
      setTestLoading(false);
    }
  }

  async function readFile(file) {
    if (!file) return;
    setError("");

    const extension = file.name.split(".").pop()?.toLowerCase();
    const allowedExtensions = ["txt", "md", "csv", "json"];
    const allowedMime = [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ];

    if (!allowedMime.includes(file.type) && !allowedExtensions.includes(extension)) {
      setError("Upload a TXT, MD, CSV or JSON file. PDF and Word files are not supported in this version.");
      return;
    }

    try {
      const text = await file.text();
      if (!text.trim()) {
        setError("The uploaded file is empty.");
        return;
      }
      setMaterial(text);
      setFileName(file.name);
    } catch {
      setError("Nova could not read that file.");
    }
  }

  function handleFile(event) {
    readFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function cleanMaterial(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 3500);
  }

  function normalizeBatchQuestion(item, index, type) {
    if (!item || typeof item !== "object") return null;
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (!question) return null;

    const rawOptions = Array.isArray(item.options)
      ? item.options.map((option) => {
          if (typeof option === "string") return option.trim();
          if (option && typeof option.label === "string") return option.label.trim();
          return "";
        }).filter(Boolean)
      : [];

    let options;
    let answer = item.answer;

    if (type === "mcq") {
      options = rawOptions.slice(0, 4);
      if (options.length !== 4) return null;
      // Reject letter-only placeholders. They are not real answer choices.
      if (options.some((option) => /^[A-D][.)]?$/i.test(option))) return null;
      // Reject generic template text that a small model may copy literally.
      const placeholderPattern = /^(first|second|third|fourth|correct|incorrect|wrong|right)\s+(complete\s+)?(answer|option|choice)(\s+\d+)?[.!]?$/i;
      if (options.some((option) => placeholderPattern.test(option))) return null;
      if (new Set(options.map((option) => option.toLowerCase())).size !== 4) return null;

      if (typeof answer === "string") {
        const letter = answer.trim().toUpperCase();
        if (["A", "B", "C", "D"].includes(letter)) {
          answer = ["A", "B", "C", "D"].indexOf(letter);
        } else {
          answer = Number(answer);
          if (Number.isInteger(answer) && answer >= 1 && answer <= 4) answer -= 1;
        }
      }
      answer = Number(answer);
      if (!Number.isInteger(answer) || answer < 0 || answer > 3) return null;
    } else {
      options = ["True", "False"];
      if (typeof answer === "string") {
        const value = answer.trim().toLowerCase();
        if (value === "true") answer = 0;
        else if (value === "false") answer = 1;
        else answer = Number(answer);
      }
      answer = Number(answer);
      if (!Number.isInteger(answer) || answer < 0 || answer > 1) return null;
    }

    return { id: `q-${index + 1}`, question, options, answer, type };
  }

  async function generateQuiz() {
    const cleaned = cleanMaterial(material);
    if (cleaned.length < 80) {
      setError("Please add at least 80 characters of study notes before generating the quiz.");
      return;
    }

    setLoading(true);
    setError("");
    setLmMessage("");
    setQuiz([]);
    setAnswers({});
    setSubmitted(false);
    setGenerationProgress(`Asking your local model for all ${questionCount} questions in one request...`);

    try {
      const model = await getLMStudioModel();
      const typeInstructions = questionType === "mcq"
        ? `For EACH question, write exactly four real answer choices based on the notes. Each choice must explain a specific idea, fact, definition, example, or concept. The website adds A/B/C/D labels, so do not use letters as the option text. NEVER write placeholder phrases such as "First complete answer", "Second complete answer", "Third complete answer", "Fourth complete answer", "option A", or "answer 1". The four choices must be different and meaningful. Set "answer" to 0, 1, 2, or 3 to show which option is correct.`
        : `For EACH question, use exactly the options ["True","False"]. Set "answer" to 0 when True is correct or 1 when False is correct.`;

      const prompt = `
Create a real practice quiz for a student from the study notes below.
Generate ${questionCount} short, clear, non-repeating questions using ONLY information supported by the notes.
Question type: ${questionType === "mcq" ? "multiple choice" : "true/false"}.
${typeInstructions}
Output JSON only. The JSON must have one top-level key named "questions" whose value is an array. Every array item must have three keys: "question" (a complete question), "options" (an array of answer texts), and "answer" (the correct option index as a number).
Do not output instructions, sample text, placeholder text, or explanations outside the JSON. Do not copy the words in these instructions into the answer choices. For multiple-choice questions, each option must be a genuine answer phrase or sentence related to the question and the notes.
Create exactly ${questionCount} question objects if possible. Keep answer choices short and easy to read.

STUDY NOTES:
${cleaned}
`;

      setGenerationProgress(`Generating all ${questionCount} questions with ${model}...`);
      let response = await askLMStudio([
        {
          role: "system",
          content: "Write exam questions from the notes. Output ONLY valid JSON. No markdown, no introduction, no conclusion, no placeholder words. Every MCQ needs a real question, four meaningful text options, and answer as 0, 1, 2, or 3."
        },
        { role: "user", content: prompt }
      ], 0.1, questionCount === 5 ? 1800 : 3000, true);

      let parsed = extractFirstJSONArray(response);

      // Small local models sometimes ignore the requested JSON format on the first try.
      // Ask once for a compact corrected response instead of failing immediately.
      if (!parsed || !parsed.length) {
        setGenerationProgress("The model returned an unexpected format. Asking it to format the quiz correctly...");
        const repairPrompt = `Convert this quiz into valid JSON only. Return exactly this shape: {"questions":[{"question":"...","options":["real option 1","real option 2","real option 3","real option 4"],"answer":0}]}. Make ${questionCount} questions if the source contains enough information. Do not include markdown or any text outside JSON. Do not use placeholder answers.

Study notes:
${cleaned}

Previous response to fix:
${response.slice(0, 5000)}`;
        response = await askLMStudio([
          { role: "system", content: "You repair quiz output. Return valid JSON only, with meaningful question text and complete answer choices. Never use placeholder answers." },
          { role: "user", content: repairPrompt }
        ], 0.1, questionCount === 5 ? 1800 : 3000, true);
        parsed = extractFirstJSONArray(response);
      }

      if (!parsed || !parsed.length) {
        throw new Error("LM Studio responded, but Nova still could not read a valid quiz from it. Nova now requests JSON mode from LM Studio; if this message continues, the selected model may not support JSON mode well. In LM Studio, try a chat/instruct model, keep the server running, and test with 5 questions and shorter study notes.");
      }

      const normalized = parsed
        .map((item, index) => normalizeBatchQuestion(item, index, questionType))
        .filter(Boolean);

      const unique = [];
      const seen = new Set();
      for (const item of normalized) {
        const key = item.question.toLowerCase().replace(/\W+/g, " ").trim();
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      }

      if (!unique.length) {
        throw new Error("The model did not provide complete answer choices. For multiple-choice quizzes, each option must contain the answer text, not just A, B, C, or D. Try again with 5 questions; if it repeats this, the selected local model may not be following the quiz format.");
      }

      setQuiz(unique);
      setAnswers({});
      setSubmitted(false);

      if (unique.length < questionCount) {
        setLmMessage(`Nova created ${unique.length} valid questions out of ${questionCount} requested. You can answer these now, or try again with shorter notes.`);
      } else {
        setLmMessage(`Ready! All ${unique.length} questions were generated in one request. Select an answer for each question, then submit.`);
      }
      setGenerationProgress("");
    } catch (err) {
      setQuiz([]);
      setGenerationProgress("");
      setError(err?.message || "School could not generate questions. Check that LM Studio is running and a model is loaded.");
    } finally {
      setLoading(false);
    }
  }

  function selectAnswer(questionIndex, optionIndex) {
    if (submitted) return;
    setAnswers((previous) => ({ ...previous, [questionIndex]: optionIndex }));
  }

  function submitQuiz() {
    if (Object.keys(answers).length < quiz.length) {
      setError(`Please answer every question first. You have answered ${Object.keys(answers).length} of ${quiz.length}.`);
      return;
    }
    setError("");
    setSubmitted(true);
  }

  function resetQuiz() {
    setQuiz([]);
    setAnswers({});
    setSubmitted(false);
    setError("");
    setLmMessage("");
    setGenerationProgress("");
  }

  const score = quiz.reduce(
    (total, question, index) => total + (answers[index] === question.answer ? 1 : 0),
    0
  );

  return (
    <div className="page schoolPage">
      <PageHeader
        title="School"
        subtitle="Add your study material, generate the whole quiz at once, and select answers for every question."
      />

      <div className="schoolConnection">
        <div>
          <span className="eyebrow">LM STUDIO CONNECTION</span>
          <p>School uses the model running in your local LM Studio.</p>
          {lmMessage && <div className="successMessage">{lmMessage}</div>}
          {error && <div className="errorMessage">{error}</div>}
        </div>
        <button className="secondaryButton" onClick={testLMStudio} disabled={testLoading}>
          {testLoading ? "TESTING..." : "TEST LM STUDIO"}
        </button>
      </div>

      {!quiz.length && !loading && (
        <div className="schoolGrid">
          <div className="panel">
            <h2>Study material</h2>
            <p className="muted">Paste your notes or upload a TXT, MD, CSV or JSON file.</p>
            <textarea
              className="materialBox"
              value={material}
              onChange={(event) => setMaterial(event.target.value)}
              placeholder="Paste your study material here..."
            />
            <div className="materialBottom">
              <span>{material.length.toLocaleString()} characters</span>
              {fileName && <span className="fileBadge">{fileName}</span>}
            </div>
            <label className="uploadButton">
              UPLOAD STUDY FILE
              <input
                type="file"
                accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
                onChange={handleFile}
              />
            </label>
          </div>

          <div className="panel">
            <h2>Quiz settings</h2>
            <div className="settingGroup">
              <label>Number of questions</label>
              <div className="choiceRow">
                {[5, 10].map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={questionCount === count ? "choiceButton active" : "choiceButton"}
                    onClick={() => setQuestionCount(count)}
                  >
                    {count} QUESTIONS
                  </button>
                ))}
              </div>
            </div>

            <div className="settingGroup">
              <label>Question type</label>
              <div className="choiceRow">
                <button
                  type="button"
                  className={questionType === "mcq" ? "choiceButton active" : "choiceButton"}
                  onClick={() => setQuestionType("mcq")}
                >
                  A / B / C / D
                </button>
                <button
                  type="button"
                  className={questionType === "tf" ? "choiceButton active" : "choiceButton"}
                  onClick={() => setQuestionType("tf")}
                >
                  TRUE / FALSE
                </button>
              </div>
            </div>

            <button
              className="generateButton"
              onClick={generateQuiz}
              disabled={loading || material.trim().length < 80}
            >
              GENERATE ALL {questionCount} QUESTIONS
            </button>

            <div className="schoolTip">
              <strong>How it works</strong>
              <p>Nova asks LM Studio for the complete set in one request. Once it appears, every question stays on the page so you can click an answer for each one before submitting.</p>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="largeLoading">
          <div className="loadingOrb large" />
          <h2>Generating your full quiz...</h2>
          <p>{generationProgress}</p>
          <small>Keep LM Studio open with the model loaded. Nova can retry once if the model formats the quiz incorrectly. Try 5 questions first.</small>
        </div>
      )}

      {!loading && quiz.length > 0 && (
        <div className="quizPanel">
          <div className="quizTop">
            <span>{submitted ? "QUIZ RESULTS" : `${Object.keys(answers).length} OF ${quiz.length} ANSWERED`}</span>
            <span>{submitted ? `SCORE: ${score} / ${quiz.length}` : `QUESTIONS: ${quiz.length}`}</span>
          </div>

          {quiz.map((question, questionIndex) => (
            <section className="quizQuestionCard" key={question.id}>
              <div className="quizType">QUESTION {questionIndex + 1} · {question.type === "mcq" ? "MULTIPLE CHOICE" : "TRUE / FALSE"}</div>
              <h2>{question.question}</h2>
              <div className={question.type === "mcq" ? "answerGrid" : "answerGrid trueFalse"}>
                {question.options.map((option, optionIndex) => {
                  const selected = answers[questionIndex] === optionIndex;
                  const correct = submitted && optionIndex === question.answer;
                  const wrongSelected = submitted && selected && optionIndex !== question.answer;
                  let className = "answerButton";
                  if (selected) className += " selected";
                  if (correct) className += " correct";
                  if (wrongSelected) className += " wrong";

                  return (
                    <button
                      key={`${question.id}-${optionIndex}`}
                      type="button"
                      className={className}
                      onClick={() => selectAnswer(questionIndex, optionIndex)}
                      disabled={submitted}
                      aria-pressed={selected}
                    >
                      {question.type === "mcq" && (
                        <span className="answerLetter">{["A", "B", "C", "D"][optionIndex]}</span>
                      )}
                      {option}
                      {selected && !submitted && <span className="selectedMark"> ✓ Selected</span>}
                    </button>
                  );
                })}
              </div>

              {submitted && (
                <div className={answers[questionIndex] === question.answer ? "answerFeedback correctFeedback" : "answerFeedback wrongFeedback"}>
                  {answers[questionIndex] === question.answer
                    ? "✓ Correct"
                    : `✕ Your answer: ${question.options[answers[questionIndex]]}. Correct answer: ${question.options[question.answer]}.`}
                </div>
              )}
            </section>
          ))}

          {!submitted ? (
            <button
              className="primaryButton nextButton"
              onClick={submitQuiz}
              disabled={Object.keys(answers).length !== quiz.length}
            >
              SUBMIT ALL ANSWERS
            </button>
          ) : (
            <div className="quizResult">
              <div className="resultOrb">N</div>
              <div className="eyebrow">QUIZ COMPLETE</div>
              <h2>{score} / {quiz.length}</h2>
              <p>{score === quiz.length
                ? "Perfect score. Nova is impressed."
                : score >= quiz.length * 0.7
                ? "Great work. Review the questions you missed."
                : "Good attempt. Review your material and try again."}</p>
              <button className="primaryButton" onClick={resetQuiz}>GENERATE A NEW QUIZ</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   TALK TO NOVA
========================================================= */

function TalkToNova() {
  const [messages, setMessages] = useState([
    {
      role: "nova",
      text: "Hello. I'm Nova. What would you like to do?",
    },
  ]);

  const [input, setInput] = useState("");

  const [thinking, setThinking] =
    useState(false);

  const [listening, setListening] =
    useState(false);

  const recognitionRef = useRef(null);

  async function sendMessage(customText) {
    const text = (
      customText !== undefined
        ? customText
        : input
    ).trim();

    if (!text || thinking) return;

    setInput("");

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        text,
      },
    ]);

    setThinking(true);

    try {
      const history = messages
        .slice(-8)
        .map((message) => ({
          role:
            message.role === "nova"
              ? "assistant"
              : "user",
          content: message.text,
        }));

      history.push({
        role: "user",
        content: text,
      });

      const answer = await askLMStudio(
        [
          {
            role: "system",
            content:
              "You are Nova, a helpful personal AI assistant. Give natural, concise and useful answers.",
          },
          ...history,
        ],
        0.45
      );

      setMessages((prev) => [
        ...prev,
        {
          role: "nova",
          text: answer,
        },
      ]);

      speak(answer);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "nova",
          text:
            err?.message ||
            "I could not connect to LM Studio.",
        },
      ]);
    } finally {
      setThinking(false);
    }
  }

  function speak(text) {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();

    const utterance =
      new SpeechSynthesisUtterance(text);

    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1;

    const voices =
      window.speechSynthesis.getVoices();

    const femaleVoice = voices.find((voice) =>
      /female|zira|samantha|susan|karen|victoria/i.test(
        voice.name
      )
    );

    if (femaleVoice) {
      utterance.voice = femaleVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  function activateMic() {
    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setMessages((prev) => [
        ...prev,
        {
          role: "nova",
          text:
            "Voice recognition is not supported by this browser.",
        },
      ]);

      return;
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }

    const recognition =
      new SpeechRecognition();

    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onresult = (event) => {
      const transcript =
        event.results?.[0]?.[0]?.transcript || "";

      setInput(transcript);

      if (transcript.trim()) {
        sendMessage(transcript);
      }
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;

    recognition.start();
  }

  return (
    <div className="page talkPage">
      <PageHeader
        title="Talk to Nova"
        subtitle="Conversation powered by your local AI."
      />

      <div className="chatPanel">
        <div className="chatMessages">
          {messages.map((message, index) => (
            <div
              className={`chatBubble ${
                message.role === "user"
                  ? "userBubble"
                  : "novaBubble"
              }`}
              key={index}
            >
              <small>
                {message.role === "user"
                  ? "YOU"
                  : "NOVA"}
              </small>

              <p>{message.text}</p>
            </div>
          ))}

          {thinking && (
            <div className="chatBubble novaBubble">
              <small>NOVA</small>
              <p>Thinking...</p>
            </div>
          )}
        </div>

        <div className="chatInput">
          <button
            className={
              listening
                ? "micButton listening"
                : "micButton"
            }
            onClick={activateMic}
            title="Voice input"
          >
            {listening ? "●" : "🎙"}
          </button>

          <input
            value={input}
            onChange={(e) =>
              setInput(e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                sendMessage();
              }
            }}
            placeholder="Ask Nova something..."
          />

          <button
            className="sendButton"
            onClick={() => sendMessage()}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   DIGITAL SAFETY
========================================================= */

function DigitalSafety() {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);

  function scan() {
    if (!text.trim()) {
      setResult(null);
      return;
    }

    const lower = text.toLowerCase();
    const warnings = [];
    const suspiciousWords = [
      "verify your account",
      "send money",
      "bank details",
      "one time password",
      "you have won",
      "gift card",
      "act now",
      "urgent",
      "click here",
      "password",
      "otp",
      "crypto",
      "limited time",
    ];

    suspiciousWords.forEach((word) => {
      if (lower.includes(word)) warnings.push(`Message contains: "${word}"`);
    });

    // Extract URLs and safely parse bare www. links too.
    const urlMatches = text.match(
      /(?:https?:\/\/|www\.)[^\s<>"']+/gi
    ) || [];
    const urls = [...new Set(urlMatches.map((item) => item.replace(/[),.!?;]+$/, "")))];
    const hosts = [];
    let insecureHttp = false;
    let suspiciousUrl = false;

    const shorteners = new Set([
      "bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "rb.gy",
      "shorturl.at", "rebrand.ly"
    ]);

    urls.forEach((rawUrl) => {
      try {
        const candidate = /^https?:\/\//i.test(rawUrl)
          ? rawUrl
          : `https://${rawUrl}`;
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        hosts.push(host);

        if (parsed.protocol === "http:") {
          insecureHttp = true;
          warnings.push(`Link does not use HTTPS: ${host}`);
        }

        if (host.startsWith("xn--") || host.split(".").some((part) => part.startsWith("xn--"))) {
          suspiciousUrl = true;
          warnings.push(`Link uses an internationalized/punycode domain: ${host}`);
        }

        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) {
          suspiciousUrl = true;
          warnings.push(`Link uses an IP address instead of a normal domain: ${host}`);
        }

        if (shorteners.has(host)) {
          suspiciousUrl = true;
          warnings.push(`Shortened link hides the final destination: ${host}`);
        }

        if (parsed.username || parsed.password) {
          suspiciousUrl = true;
          warnings.push(`Link contains unexpected login details before the domain: ${host}`);
        }
      } catch {
        suspiciousUrl = true;
        warnings.push(`Could not parse this link: ${rawUrl}`);
      }
    });

    const hasMoney = /\b(?:k\s?\d+|\$\s?\d+|€\s?\d+|£\s?\d+)\b/i.test(text);
    if (hasMoney && /send money|pay now|transfer|bank details|gift card/i.test(lower)) {
      warnings.push("Money/payment request detected");
    }

    const uniqueWarnings = [...new Set(warnings)];
    let level = "LOW";

    if (
      uniqueWarnings.length >= 4 ||
      (suspiciousUrl && uniqueWarnings.length >= 2) ||
      (/(verify your account|send money|bank details|one time password|gift card)/i.test(lower) &&
       /(urgent|act now|click here|you have won)/i.test(lower))
    ) {
      level = "HIGH";
    } else if (
      uniqueWarnings.length >= 1 ||
      insecureHttp ||
      suspiciousUrl ||
      (hasMoney && /send money|pay now|transfer/i.test(lower))
    ) {
      level = "MEDIUM";
    }

    setResult({
      level,
      warnings: uniqueWarnings,
      hasUrl: urls.length > 0,
      hosts: [...new Set(hosts)],
      urlCount: urls.length,
      insecureHttp,
      hasMoney,
    });
  }

  return (
    <div className="page">
      <PageHeader
        title="Digital Safety"
        subtitle="Check suspicious messages, links and requests before you act."
      />

      <div className="safetyPanel">
        <textarea
          className="materialBox safetyBox"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a suspicious message, email, link or text here..."
        />

        <button
          className="generateButton"
          onClick={scan}
        >
          SCAN FOR THREATS
        </button>

        {result && (
          <div
            className={`safetyResult ${result.level.toLowerCase()}`}
          >
            <div className="safetyLevel">
              {result.level} RISK
            </div>

            {result.level === "LOW" && (
              <p>
                No obvious warning signs were found by these basic checks. This does NOT prove the link is safe; the scanner does not check live threat databases.
              </p>
            )}

            {result.level === "MEDIUM" && (
              <p>
                Some warning signs were found. Check the destination carefully and do not enter passwords, payment details or verification codes unless you have independently confirmed the site.
              </p>
            )}

            {result.level === "HIGH" && (
              <p>
                Several warning signs were found. Do not open the link or share money, passwords or verification codes unless you independently verify the request.
              </p>
            )}

            {result.hosts?.length > 0 && (
              <p>
                {`Domain${result.hosts.length > 1 ? "s" : ""} found: ${result.hosts.join(", ")}`}
              </p>
            )}

            {result.hasUrl && (
              <p>
                Nova checks link structure and common warning signs only. It does not verify website reputation or malware in real time, so it cannot certify a link as safe.
              </p>
            )}

            {result.warnings.length > 0 && (
              <div className="warningList">
                {result.warnings.map((warning) => (
                  <span key={warning}>
                    {warning}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   MENU
========================================================= */

const menuItems = [
  ["home", "HOME"],
  ["dashboard", "DASHBOARD"],
  ["timetable", "TIMETABLE"],
  ["school", "SCHOOL"],
  ["talk", "TALK TO NOVA"],
  ["reminders", "REMINDERS"],
  ["budget", "BUDGET MODE"],
  ["safety", "DIGITAL SAFETY"],
];

/* =========================================================
   APP
========================================================= */

export default function App() {
  const [page, setPage] = useState("home");

  const [menuOpen, setMenuOpen] =
    useState(false);

  const [lmStatus, setLmStatus] = useState({
    connected: false,
    model: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function checkLM() {
      try {
        const model = await getLMStudioModel();

        if (!cancelled) {
          setLmStatus({
            connected: true,
            model,
          });
        }
      } catch {
        if (!cancelled) {
          setLmStatus({
            connected: false,
            model: "",
          });
        }
      }
    }

    checkLM();

    const interval = setInterval(
      checkLM,
      10000
    );

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  function navigate(target) {
    setPage(target);
    setMenuOpen(false);
  }

  let content;

  if (page === "home") {
    content = (
      <Home
        setPage={navigate}
        lmStatus={lmStatus}
      />
    );
  } else if (page === "dashboard") {
    content = <Dashboard lmStatus={lmStatus} />;
  } else if (page === "timetable") {
    content = <Timetable />;
  } else if (page === "school") {
    content = <School />;
  } else if (page === "talk") {
    content = <TalkToNova />;
  } else if (page === "reminders") {
    content = <Reminders />;
  } else if (page === "budget") {
    content = <Budget />;
  } else if (page === "safety") {
    content = <DigitalSafety />;
  }

  return (
    <div className="novaApp">
      <style>{`
        * {
          box-sizing: border-box;
        }

        html,
        body,
        #root {
          margin: 0;
          width: 100%;
          min-height: 100%;
          background: #02040a;
        }

        body {
          font-family:
            Inter,
            ui-sans-serif,
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
          color: #eef7ff;
        }

        button,
        input,
        textarea,
        select {
          font: inherit;
        }

        button {
          cursor: pointer;
        }

        .novaApp {
          min-height: 100vh;
          background:
            radial-gradient(
              circle at 50% 35%,
              rgba(0, 100, 255, 0.12),
              transparent 35%
            ),
            #02040a;
          overflow-x: hidden;
        }

        .page {
          min-height: 100vh;
          padding: 120px 7vw 70px;
          background:
            radial-gradient(
              circle at 80% 10%,
              rgba(0, 112, 255, 0.09),
              transparent 28%
            );
        }

        /* HOME */

        .homePage {
          height: 100vh;
          min-height: 700px;
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(
              circle at center,
              rgba(0, 100, 255, 0.09),
              transparent 38%
            ),
            #02040a;
        }

        .homeTop {
          position: absolute;
          z-index: 20;
          top: 28px;
          left: 42px;
          right: 42px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }

        .novaLogo {
          font-size: 24px;
          font-weight: 800;
          letter-spacing: 8px;
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .novaOrb {
          width: 13px;
          height: 13px;
          border-radius: 50%;
          background: #159dff;
          box-shadow:
            0 0 10px #159dff,
            0 0 30px rgba(21,157,255,.8);
        }

        .localText {
          margin-top: 8px;
          font-size: 10px;
          letter-spacing: 4px;
          color: #5e7892;
        }

        .homeStatus {
          font-size: 10px;
          letter-spacing: 2px;
          color: #6f879d;
          display: flex;
          align-items: center;
          gap: 9px;
        }

        .statusDot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }

        .statusDot.online {
          background: #42e8a1;
          box-shadow: 0 0 14px #42e8a1;
        }

        .statusDot.offline {
          background: #ff5577;
          box-shadow: 0 0 12px #ff5577;
        }

        .earthArea {
          position: absolute;
          inset: 0;
        }

        .earthCanvas {
          position: absolute;
          inset: 0;
        }

        .earthGlow {
          position: absolute;
          z-index: 0;
          left: 50%;
          top: 52%;
          width: 650px;
          height: 650px;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          background: rgba(0, 105, 255, .08);
          filter: blur(70px);
          pointer-events: none;
        }

        .earthText {
          position: absolute;
          z-index: 10;
          left: 7vw;
          top: 50%;
          transform: translateY(-50%);
          width: 310px;
          pointer-events: none;
        }

        .earthText > * {
          pointer-events: auto;
        }

        .smallLabel,
        .eyebrow {
          font-size: 10px;
          letter-spacing: 4px;
          color: #5595c9;
          font-weight: 700;
        }

        .earthText h1 {
          font-size: clamp(60px, 7vw, 110px);
          line-height: .8;
          letter-spacing: -7px;
          margin: 20px 0 28px;
          font-weight: 900;
        }

        .earthText h1 span {
          color: #159dff;
          text-shadow:
            0 0 20px rgba(21,157,255,.6),
            0 0 60px rgba(21,157,255,.25);
        }

        .earthText p {
          color: #7e96ac;
          line-height: 1.7;
          font-size: 14px;
          margin-bottom: 26px;
        }

        .earthControls {
          position: absolute;
          z-index: 30;
          right: 35px;
          bottom: 35px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .earthControls button {
          width: 44px;
          height: 44px;
          border: 1px solid rgba(80,160,255,.35);
          border-radius: 50%;
          background: rgba(3,12,25,.72);
          color: #a8dcff;
          font-size: 24px;
          backdrop-filter: blur(10px);
          transition: .2s;
        }

        .earthControls button:hover {
          background: rgba(15,100,190,.3);
          border-color: #159dff;
          box-shadow: 0 0 20px rgba(21,157,255,.25);
        }

        /* MENU */

        .menuButton {
          position: fixed;
          z-index: 100;
          right: 28px;
          top: 25px;
          width: 50px;
          height: 50px;
          border-radius: 15px;
          border: 1px solid rgba(80,160,255,.28);
          background: rgba(4,10,20,.72);
          color: white;
          backdrop-filter: blur(18px);
          font-size: 22px;
          transition: .25s;
        }

        .menuButton:hover {
          border-color: #159dff;
          box-shadow: 0 0 30px rgba(21,157,255,.25);
        }

        .menuPanel {
          position: fixed;
          z-index: 99;
          right: 28px;
          top: 84px;
          width: 260px;
          padding: 12px;
          background: rgba(3,8,17,.94);
          border: 1px solid rgba(80,160,255,.2);
          border-radius: 20px;
          backdrop-filter: blur(25px);
          box-shadow:
            0 30px 80px rgba(0,0,0,.55),
            0 0 30px rgba(0,90,255,.08);
        }

        .menuItem {
          width: 100%;
          text-align: left;
          padding: 14px 15px;
          border: 0;
          background: transparent;
          color: #8298ad;
          border-radius: 12px;
          font-size: 11px;
          letter-spacing: 2px;
          transition: .2s;
        }

        .menuItem:hover,
        .menuItem.active {
          color: white;
          background: rgba(21,157,255,.1);
        }

        /* BUTTONS */

        .primaryButton,
        .secondaryButton,
        .generateButton,
        .sendButton {
          border: 1px solid rgba(30,157,255,.5);
          color: white;
          background: linear-gradient(
            135deg,
            #0878d8,
            #0753a8
          );
          border-radius: 12px;
          padding: 13px 20px;
          font-size: 11px;
          letter-spacing: 2px;
          font-weight: 800;
          transition: .2s;
        }

        .primaryButton:hover,
        .generateButton:hover,
        .sendButton:hover {
          transform: translateY(-2px);
          box-shadow:
            0 12px 35px rgba(0,110,255,.25),
            0 0 25px rgba(0,130,255,.2);
        }

        .primaryButton:disabled,
        .generateButton:disabled,
        .secondaryButton:disabled,
        .sendButton:disabled {
          opacity: .4;
          cursor: not-allowed;
          transform: none;
        }

        .full {
          width: 100%;
        }

        .secondaryButton {
          background: rgba(21,157,255,.08);
          border-color: rgba(21,157,255,.25);
          color: #86cfff;
        }

        .dangerButton {
          border: 1px solid rgba(255,70,100,.25);
          color: #ff718d;
          background: rgba(255,50,80,.06);
          padding: 7px 10px;
          border-radius: 8px;
          font-size: 9px;
          letter-spacing: 1px;
        }

        /* PAGE HEADER */

        .pageHeader {
          display: flex;
          justify-content: space-between;
          margin-bottom: 42px;
        }

        .pageHeader h1 {
          margin: 8px 0;
          font-size: clamp(42px, 5vw, 72px);
          letter-spacing: -3px;
        }

        .pageHeader p {
          margin: 0;
          color: #687f94;
        }

        /* DASHBOARD */

        .dashboardGrid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
        }

        .dashCard {
          min-height: 170px;
          padding: 25px;
          border-radius: 20px;
          border: 1px solid rgba(90,150,210,.13);
          background: linear-gradient(
            145deg,
            rgba(13,25,43,.8),
            rgba(4,10,18,.8)
          );
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .dashCard.large {
          grid-column: span 2;
        }

        .dashCard span,
        .moneyCard span {
          font-size: 9px;
          letter-spacing: 3px;
          color: #56738e;
        }

        .dashCard strong {
          font-size: 27px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .dashCard small {
          color: #587187;
        }

        /* PANELS */

        .twoColumn {
          display: grid;
          grid-template-columns: 360px 1fr;
          gap: 20px;
        }

        .panel {
          padding: 25px;
          border-radius: 20px;
          border: 1px solid rgba(90,150,210,.13);
          background: rgba(7,15,27,.78);
        }

        .panel h2 {
          margin-top: 0;
          margin-bottom: 20px;
        }

        .panel input,
        .panel select,
        .chatInput input {
          width: 100%;
          border: 1px solid rgba(100,160,210,.16);
          background: rgba(0,0,0,.28);
          color: white;
          padding: 13px 14px;
          border-radius: 10px;
          outline: none;
          margin-bottom: 12px;
        }

        .panel input:focus,
        .panel select:focus,
        .chatInput input:focus,
        textarea:focus {
          border-color: rgba(21,157,255,.5);
          box-shadow: 0 0 20px rgba(21,157,255,.07);
        }

        .panel select option {
          background: #07101d;
        }

        .list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .listItem {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 15px;
          padding: 15px;
          border-radius: 12px;
          background: rgba(255,255,255,.025);
          border: 1px solid rgba(255,255,255,.05);
        }

        .listItem strong {
          display: block;
        }

        .listItem small {
          display: block;
          color: #62788d;
          margin-top: 4px;
        }

        .empty {
          color: #546c82;
          padding: 30px 0;
          text-align: center;
        }

        /* BUDGET */

        .moneyGrid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 15px;
          margin-bottom: 20px;
        }

        .moneyCard {
          padding: 25px;
          border-radius: 18px;
          border: 1px solid rgba(90,150,210,.13);
          background: rgba(7,15,27,.78);
        }

        .moneyCard strong {
          display: block;
          margin-top: 20px;
          font-size: 26px;
        }

        .savingsBox {
          margin-top: 25px;
          padding-top: 20px;
          border-top: 1px solid rgba(255,255,255,.07);
        }

        .savingsBox label {
          display: block;
          font-size: 10px;
          color: #698298;
          letter-spacing: 2px;
          margin-bottom: 8px;
        }

        .transactionRight {
          display: flex;
          align-items: center;
          gap: 15px;
        }

        /* SCHOOL */

        .schoolConnection {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 20px;
          margin-bottom: 20px;
          padding: 18px 20px;
          border-radius: 18px;
          border: 1px solid rgba(21,157,255,.15);
          background: rgba(21,157,255,.035);
        }

        .schoolConnection p {
          color: #647c91;
          margin: 7px 0 0;
        }

        .successMessage {
          margin-top: 10px;
          color: #54e6a4;
          font-size: 12px;
        }

        .errorMessage {
          margin-top: 10px;
          color: #ff718d;
          background: rgba(255,60,90,.07);
          border: 1px solid rgba(255,60,90,.18);
          padding: 10px 12px;
          border-radius: 9px;
          font-size: 12px;
          line-height: 1.5;
        }

        .schoolGrid {
          display: grid;
          grid-template-columns: 1.2fr .8fr;
          gap: 20px;
        }

        .muted {
          color: #61778d;
          font-size: 13px;
          line-height: 1.6;
        }

        .materialBox {
          width: 100%;
          min-height: 290px;
          resize: vertical;
          background: #02070e;
          color: #dcefff;
          border: 1px solid rgba(80,150,210,.16);
          border-radius: 14px;
          padding: 16px;
          outline: none;
          line-height: 1.6;
        }

        .materialBottom {
          display: flex;
          justify-content: space-between;
          margin-top: 9px;
          color: #4e667c;
          font-size: 10px;
        }

        .fileBadge {
          color: #65baff;
        }

        .uploadButton {
          display: block;
          text-align: center;
          margin-top: 15px;
          padding: 13px;
          border: 1px dashed rgba(80,160,255,.35);
          border-radius: 11px;
          color: #70bfff;
          font-size: 10px;
          letter-spacing: 2px;
          cursor: pointer;
        }

        .uploadButton:hover {
          background: rgba(21,157,255,.05);
        }

        .uploadButton input {
          display: none;
        }

        .settingGroup {
          margin-bottom: 25px;
        }

        .settingGroup label {
          display: block;
          color: #668096;
          font-size: 10px;
          letter-spacing: 2px;
          margin-bottom: 10px;
        }

        .choiceRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .choiceButton {
          padding: 13px 8px;
          border: 1px solid rgba(90,150,210,.14);
          border-radius: 10px;
          background: rgba(255,255,255,.025);
          color: #71879c;
          font-size: 10px;
          letter-spacing: 1px;
        }

        .choiceButton:hover,
        .choiceButton.active {
          color: #a9ddff;
          border-color: rgba(21,157,255,.5);
          background: rgba(21,157,255,.1);
        }

        .generateButton {
          width: 100%;
          margin-top: 8px;
        }

        .schoolTip {
          margin-top: 20px;
          padding: 15px;
          border-radius: 12px;
          background: rgba(255,255,255,.025);
          color: #61778d;
          font-size: 12px;
          line-height: 1.6;
        }

        .schoolTip strong {
          color: #91b8d8;
        }

        .progressBox {
          margin-top: 15px;
          display: flex;
          align-items: center;
          gap: 12px;
          color: #68bfff;
          font-size: 11px;
        }

        .loadingOrb {
          width: 20px;
          height: 20px;
          border: 2px solid rgba(21,157,255,.2);
          border-top-color: #159dff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          flex-shrink: 0;
        }

        .loadingOrb.large {
          width: 60px;
          height: 60px;
          border-width: 3px;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .largeLoading {
          min-height: 450px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
        }

        .largeLoading h2 {
          margin: 25px 0 5px;
        }

        .largeLoading p {
          color: #68bfff;
        }

        .largeLoading small {
          color: #4d6479;
        }

        .quizPanel {
          max-width: 900px;
          margin: 40px auto;
          padding: 35px;
          border: 1px solid rgba(90,150,210,.16);
          border-radius: 25px;
          background:
            radial-gradient(
              circle at 50% 0%,
              rgba(0,110,255,.09),
              transparent 35%
            ),
            rgba(5,12,22,.9);
        }

        .quizTop {
          display: flex;
          justify-content: space-between;
          color: #5d7991;
          font-size: 10px;
          letter-spacing: 2px;
          padding-bottom: 20px;
          border-bottom: 1px solid rgba(255,255,255,.06);
        }

        .quizQuestion {
          padding: 50px 0 30px;
          text-align: center;
        }

        .quizType {
          font-size: 9px;
          color: #168fff;
          letter-spacing: 3px;
          margin-bottom: 20px;
        }

        .quizQuestion h2 {
          max-width: 750px;
          margin: auto;
          font-size: clamp(24px, 3vw, 38px);
          line-height: 1.25;
        }

        .answerGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .answerGrid.trueFalse {
          grid-template-columns: 1fr 1fr;
        }

        .answerButton {
          min-height: 75px;
          text-align: left;
          padding: 16px 18px;
          border: 1px solid rgba(90,150,210,.14);
          border-radius: 13px;
          background: rgba(255,255,255,.025);
          color: #b6cadb;
          transition: .2s;
        }

        .answerButton:hover:not(:disabled) {
          transform: translateY(-2px);
          border-color: rgba(21,157,255,.5);
          background: rgba(21,157,255,.08);
        }

        .answerButton.selected {
          border-color: #168fff;
          background: rgba(21,157,255,.1);
        }

        .answerButton.correct {
          border-color: #3fe39d;
          background: rgba(63,227,157,.1);
          color: #72edb7;
        }

        .answerButton.wrong {
          border-color: #ff5577;
          background: rgba(255,85,119,.08);
          color: #ff8099;
        }

        .answerLetter {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          border-radius: 8px;
          background: rgba(21,157,255,.09);
          color: #58baff;
          margin-right: 12px;
          font-weight: 800;
        }

        .answerFeedback {
          margin-top: 20px;
          padding: 14px;
          border-radius: 10px;
          text-align: center;
        }

        .correctFeedback {
          background: rgba(63,227,157,.07);
          color: #55e6a4;
        }

        .wrongFeedback {
          background: rgba(255,85,119,.07);
          color: #ff718d;
        }

        .nextButton {
          width: 100%;
          margin-top: 20px;
        }

        .quizResult {
          max-width: 600px;
          margin: 80px auto;
          text-align: center;
          padding: 50px;
          border: 1px solid rgba(90,150,210,.16);
          border-radius: 25px;
          background: rgba(5,12,22,.9);
        }

        .resultOrb {
          width: 70px;
          height: 70px;
          margin: 0 auto 25px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          background: rgba(21,157,255,.1);
          border: 1px solid rgba(21,157,255,.4);
          color: #55baff;
          box-shadow: 0 0 40px rgba(21,157,255,.2);
          font-weight: 900;
        }

        .quizResult h2 {
          font-size: 70px;
          margin: 20px 0;
        }

        .quizResult p {
          color: #698196;
          margin-bottom: 30px;
        }

        /* TALK */

        .chatPanel {
          max-width: 1000px;
          height: calc(100vh - 260px);
          min-height: 500px;
          margin: auto;
          display: flex;
          flex-direction: column;
          border: 1px solid rgba(90,150,210,.14);
          border-radius: 22px;
          overflow: hidden;
          background: rgba(5,12,22,.8);
        }

        .chatMessages {
          flex: 1;
          overflow-y: auto;
          padding: 25px;
          display: flex;
          flex-direction: column;
          gap: 13px;
        }

        .chatBubble {
          max-width: 75%;
          padding: 15px;
          border-radius: 14px;
          line-height: 1.6;
        }

        .chatBubble small {
          color: #5e7891;
          font-size: 8px;
          letter-spacing: 2px;
        }

        .chatBubble p {
          margin-bottom: 0;
          white-space: pre-wrap;
        }

        .novaBubble {
          align-self: flex-start;
          background: rgba(21,157,255,.07);
          border: 1px solid rgba(21,157,255,.12);
        }

        .userBubble {
          align-self: flex-end;
          background: rgba(255,255,255,.05);
          border: 1px solid rgba(255,255,255,.07);
        }

        .chatInput {
          display: flex;
          gap: 10px;
          padding: 15px;
          border-top: 1px solid rgba(255,255,255,.06);
        }

        .chatInput input {
          margin: 0;
          flex: 1;
        }

        .micButton {
          width: 48px;
          border-radius: 11px;
          border: 1px solid rgba(21,157,255,.25);
          background: rgba(21,157,255,.07);
          color: #72c7ff;
        }

        .micButton.listening {
          color: #ff718d;
          border-color: rgba(255,85,119,.5);
          box-shadow: 0 0 20px rgba(255,85,119,.15);
        }

        /* SAFETY */

        .safetyPanel {
          max-width: 900px;
          margin: auto;
          padding: 25px;
          border: 1px solid rgba(90,150,210,.13);
          border-radius: 20px;
          background: rgba(7,15,27,.8);
        }

        .safetyBox {
          min-height: 260px;
          margin-bottom: 15px;
        }

        .safetyResult {
          margin-top: 20px;
          padding: 20px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,.06);
        }

        .safetyResult.low {
          background: rgba(63,227,157,.06);
          color: #73e8b7;
        }

        .safetyResult.medium {
          background: rgba(255,190,60,.06);
          color: #ffca67;
        }

        .safetyResult.high {
          background: rgba(255,70,100,.07);
          color: #ff718d;
        }

        .safetyLevel {
          font-weight: 900;
          letter-spacing: 2px;
          margin-bottom: 10px;
        }

        .warningList {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
        }

        .warningList span {
          padding: 7px 10px;
          border-radius: 8px;
          background: rgba(255,255,255,.06);
          font-size: 10px;
        }

        @media (max-width: 1000px) {
          .earthText {
            left: 35px;
          }

          .earthText h1 {
            font-size: 70px;
          }

          .dashboardGrid,
          .moneyGrid {
            grid-template-columns: 1fr 1fr;
          }

          .schoolGrid,
          .twoColumn {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 700px) {
          .page {
            padding: 100px 20px 40px;
          }

          .homeTop {
            left: 20px;
            right: 20px;
          }

          .homeStatus {
            display: none;
          }

          .earthText {
            left: 25px;
            top: auto;
            bottom: 45px;
            transform: none;
            width: 250px;
          }

          .earthText h1 {
            font-size: 58px;
          }

          .earthText p {
            display: none;
          }

          .dashboardGrid,
          .moneyGrid {
            grid-template-columns: 1fr;
          }

          .dashCard.large {
            grid-column: span 1;
          }

          .answerGrid {
            grid-template-columns: 1fr;
          }

          .quizPanel {
            padding: 20px;
          }

          .schoolConnection {
            flex-direction: column;
            align-items: stretch;
          }

          .chatBubble {
            max-width: 90%;
          }

          .choiceRow {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {/* Hidden navigation */}
      <button
        className="menuButton"
        onClick={() =>
          setMenuOpen((previous) => !previous)
        }
        aria-label="Open Nova navigation"
      >
        {menuOpen ? "×" : "☰"}
      </button>

      {menuOpen && (
        <div className="menuPanel">
          {menuItems.map(([id, label]) => (
            <button
              key={id}
              className={
                page === id
                  ? "menuItem active"
                  : "menuItem"
              }
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {content}
    </div>
  );
}