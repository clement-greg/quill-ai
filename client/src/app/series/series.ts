import { Component, inject, signal, OnInit, computed } from '@angular/core';

const WRITING_QUOTES: { text: string; author: string }[] = [
  { text: "Start writing, no matter what. The water does not flow until the faucet is turned on.", author: "Louis L'Amour" },
  { text: "You can always edit a bad page. You can't edit a blank page.", author: "Jodi Picoult" },
  { text: "There is nothing to writing. All you do is sit down at a typewriter and bleed.", author: "Ernest Hemingway" },
  { text: "If there's a book that you want to read, but it hasn't been written yet, then you must write it.", author: "Toni Morrison" },
  { text: "The first draft of anything is shit.", author: "Ernest Hemingway" },
  { text: "Writing is the painting of the voice.", author: "Voltaire" },
  { text: "Either write something worth reading or do something worth writing.", author: "Benjamin Franklin" },
  { text: "A writer is someone for whom writing is more difficult than it is for other people.", author: "Thomas Mann" },
  { text: "One day I will find the right words, and they will be simple.", author: "Jack Kerouac" },
  { text: "If you don't have time to read, you don't have the time — or the tools — to write.", author: "Stephen King" },
  { text: "The scariest moment is always just before you start.", author: "Stephen King" },
  { text: "The most valuable of all talents is that of never using two words when one will do.", author: "Thomas Jefferson" },
  { text: "Easy reading is damn hard writing.", author: "Nathaniel Hawthorne" },
  { text: "Fill your paper with the breathings of your heart.", author: "William Wordsworth" },
  { text: "Writing is thinking. To write well is to think clearly. That's why it's so hard.", author: "David McCullough" },
  { text: "The pen is the tongue of the mind.", author: "Miguel de Cervantes" },
  { text: "You must stay drunk on writing so reality cannot destroy you.", author: "Ray Bradbury" },
  { text: "We are all apprentices in a craft where no one ever becomes a master.", author: "Ernest Hemingway" },
  { text: "Writing is the only thing that, when I do it, I don't feel I should be doing something else.", author: "Gloria Steinem" },
  { text: "You fail only if you stop writing.", author: "Ray Bradbury" },
  { text: "The difference between the right word and the almost right word is the difference between lightning and a lightning bug.", author: "Mark Twain" },
  { text: "You have to write the book that wants to be written.", author: "Madeleine L'Engle" },
  { text: "The writer must believe that what he is doing is the most important thing in the world.", author: "John Steinbeck" },
  { text: "You can't wait for inspiration. You have to go after it with a club.", author: "Jack London" },
  { text: "Writing is utter solitude, the descent into the cold abyss of oneself.", author: "Franz Kafka" },
  { text: "If I don't write to empty my mind, I go mad.", author: "Lord Byron" },
  { text: "Write what disturbs you, what you fear, what you have not been willing to speak about.", author: "Natalie Goldberg" },
  { text: "The purpose of a writer is to keep civilization from destroying itself.", author: "Albert Camus" },
  { text: "Prose is architecture, not interior decoration.", author: "Ernest Hemingway" },
  { text: "The road to hell is paved with adverbs.", author: "Stephen King" },
  { text: "Write hard and clear about what hurts.", author: "Ernest Hemingway" },
  { text: "Not a wasted word. This has been a main point to my literary thinking all my life.", author: "Hunter S. Thompson" },
  { text: "A story has no beginning or end; arbitrarily one chooses that moment of experience from which to look back or from which, to look ahead.", author: "Graham Greene" },
  { text: "Be obscure clearly.", author: "E.B. White" },
  { text: "Words are a lens to focus one's mind.", author: "Ayn Rand" },
  { text: "A writer never has a vacation. For a writer, life consists of either writing or thinking about writing.", author: "Eugene Ionesco" },
  { text: "There's no such thing as writer's block. That was invented by people in California who couldn't write.", author: "Terry Pratchett" },
  { text: "A writer only begins a book. A reader finishes it.", author: "Samuel Johnson" },
  { text: "Don't tell me the moon is shining; show me the glint of light on broken glass.", author: "Anton Chekhov" },
  { text: "Every secret of a writer's soul, every experience of his life, every quality of his mind, is written large in his works.", author: "Virginia Woolf" },
  { text: "If you want to be a writer, you must do two things above all others: read a lot and write a lot.", author: "Stephen King" },
  { text: "A writer who waits for ideal conditions under which to work will die without putting a word to paper.", author: "E.B. White" },
  { text: "Write. Rewrite. When not writing or rewriting, read. I know of no shortcuts.", author: "Larry L. King" },
  { text: "We do not write in order to be understood; we write in order to understand.", author: "C.S. Lewis" },
  { text: "Writing a book is a horrible, exhausting struggle, like a long bout with some painful illness.", author: "George Orwell" },
  { text: "The most important things are the hardest to say.", author: "Stephen King" },
  { text: "An author in his book must be like God in the universe, present everywhere and visible nowhere.", author: "Gustave Flaubert" },
  { text: "Writing a novel is like driving a car at night. You can only see as far as your headlights, but you can make the whole trip that way.", author: "E.L. Doctorow" },
  { text: "Substitute 'damn' every time you're inclined to write 'very'; your editor will delete it and the writing will be just as it should be.", author: "Mark Twain" },
  { text: "I write to give myself strength. I write to be the characters that I am not. I write to explore all the things I'm afraid of.", author: "Joss Whedon" },
  { text: "The greatest part of a writer's time is spent in reading, in order to write; a man will turn over half a library to make one book.", author: "Samuel Johnson" },
  { text: "One must be drenched in words, literally soaked in them, to have the right ones form themselves into the proper pattern at the right moment.", author: "Hart Crane" },
  { text: "There is no greater agony than bearing an untold story inside you.", author: "Maya Angelou" },
  { text: "A word after a word after a word is power.", author: "Margaret Atwood" },
  { text: "You don't write because you want to say something, you write because you have something to say.", author: "F. Scott Fitzgerald" },
  { text: "No tears in the writer, no tears in the reader. No surprise in the writer, no surprise in the reader.", author: "Robert Frost" },
  { text: "The best time for planning a book is while you're doing the dishes.", author: "Agatha Christie" },
  { text: "To me, the greatest pleasure of writing is not what it's about, but the inner music the words make.", author: "Truman Capote" },
  { text: "Good writing is supposed to evoke sensation in the reader — not the fact that it is raining, but the feeling of being rained upon.", author: "E.L. Doctorow" },
  { text: "Fiction is the truth inside the lie.", author: "Stephen King" },
  { text: "The act of writing is the act of discovering what you believe.", author: "David Hare" },
  { text: "Write your first draft with your heart. Re-write with your head.", author: "Mike Rich" },
  { text: "What is written without effort is in general read without pleasure.", author: "Samuel Johnson" },
  { text: "You can make anything by writing.", author: "C.S. Lewis" },
  { text: "Never use a long word when a short one will do.", author: "George Orwell" },
  { text: "When you're writing, you're trying to find out something which you don't know.", author: "James Baldwin" },
  { text: "The art of writing is the art of applying the seat of the pants to the seat of the chair.", author: "Mary Heaton Vorse" },
  { text: "Keep a notebook. Travel with it, eat with it, sleep with it. Slap into it every stray thought that flutters up into your brain.", author: "Jack London" },
  { text: "Literature is the art of discovering something extraordinary about ordinary people, and saying with ordinary words something extraordinary.", author: "Boris Pasternak" },
  { text: "Every writer I know has trouble writing.", author: "Joseph Heller" },
  { text: "Find out what your hero or heroine wants, and when he or she wakes up in the morning, just follow him or her all day.", author: "Ray Bradbury" },
  { text: "The most beautiful stories always start with wreckage.", author: "Jack London" },
  { text: "Get it down. Take chances. It may be bad, but it's the only way you can do anything really good.", author: "William Faulkner" },
  { text: "Read, read, read. Read everything — trash, classics, good and bad, and see how they do it.", author: "William Faulkner" },
  { text: "Kill your darlings, even when it breaks your egocentric little scribbler's heart.", author: "Stephen King" },
  { text: "Writing is dreaming with your eyes open.", author: "Clive Cussler" },
  { text: "Imagination is like a muscle. I found out that the more I wrote, the bigger it got.", author: "Philip José Farmer" },
  { text: "Writing is a job, a talent, but it's also the place to go in your head.", author: "Ann Patchett" },
  { text: "Tears are words that need to be written.", author: "Paulo Coelho" },
  { text: "Write about what makes you different.", author: "Sandra Cisneros" },
  { text: "The hardest part of writing is writing.", author: "Nora Ephron" },
  { text: "A writer's job is to notice things other people don't notice.", author: "Tobias Wolff" },
  { text: "Don't use words too big for the subject. Don't say 'infinitely' when you mean 'very'.", author: "C.S. Lewis" },
  { text: "Don't tell me the moon is shining; show me the glint of light on broken glass.", author: "Anton Chekhov" },
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Writing is not about making money, getting famous, getting dates, getting laid, or making friends. In the end, it's about enriching the lives of those who will read your work.", author: "Stephen King" },
  { text: "Prose is architecture, not interior decoration, and the Baroque is over.", author: "Ernest Hemingway" },
  { text: "All the information you need can be given in dialogue.", author: "Elmore Leonard" },
  { text: "Try to leave out the part that readers tend to skip.", author: "Elmore Leonard" },
  { text: "A good style should show no sign of effort. What is written should seem a happy accident.", author: "W. Somerset Maugham" },
  { text: "When I say work, I only mean writing. Everything else is just odd jobs.", author: "Margaret Laurence" },
  { text: "There are three rules for writing a novel. Unfortunately, no one knows what they are.", author: "W. Somerset Maugham" },
  { text: "Stories may well be lies, but they are good lies that say true things.", author: "Neil Gaiman" },
  { text: "A story is a letter that the author writes to himself, to tell himself things that he would be unable to discover otherwise.", author: "Carlos Ruiz Zafón" },
  { text: "The key to good description begins with clear seeing and ends with clarity of language.", author: "Stephen King" },
  { text: "You have to surrender to your mediocrity, and just write. Because it's the writing that teaches you.", author: "Lorrie Moore" },
  { text: "A blank page is God's way of telling us how hard it is to be God.", author: "Anon" },
  { text: "The difference between fiction and reality? Fiction has to make sense.", author: "Tom Clancy" },
  { text: "If writing seems hard, it's because it is hard. It's one of the hardest things people do.", author: "William Zinsser" },
  { text: "Writers aren't exactly people — they're a whole lot of people trying to be one person.", author: "F. Scott Fitzgerald" },
  { text: "Don't bend; don't water it down; don't try to make it logical; don't edit your own soul according to the fashion.", author: "Franz Kafka" },
  { text: "Protect the time and space in which you write. Keep everybody away from it, even the people who are most important to you.", author: "Zadie Smith" },
  { text: "Worry about the craft, not the commerce.", author: "John Irving" },
  { text: "You must write every single day of your life. You must read dreadful dumbbell books and glorious books.", author: "Ray Bradbury" },
  { text: "To write is to write is to write is to write is to write is to write is to write is to write.", author: "Gertrude Stein" },
  { text: "The beautiful part of writing is that you don't have to get it right the first time, unlike, say, a brain surgeon.", author: "Robert Cormier" },
  { text: "Mostly we authors must repeat ourselves — that's the truth. We have two or three great moving experiences in our lives, and we tell about them over and over.", author: "F. Scott Fitzgerald" },
  { text: "I can shake off everything as I write; my sorrows disappear, my courage is reborn.", author: "Anne Frank" },
  { text: "I write because I don't know what I think until I read what I say.", author: "Flannery O'Connor" },
  { text: "I write to discover what I know.", author: "Flannery O'Connor" },
  { text: "I write for the same reason I breathe — because if I didn't, I would die.", author: "Isaac Asimov" },
  { text: "I write to understand as much as to be understood.", author: "Elie Wiesel" },
  { text: "Writing is nothing more than a guided dream.", author: "Jorge Luis Borges" },
  { text: "The role of a writer is not to say what we all can say, but what we are unable to say.", author: "Anaïs Nin" },
  { text: "I hate writing, I love having written.", author: "Dorothy Parker" },
  { text: "Writers live twice.", author: "Natalie Goldberg" },
  { text: "Not that the story need be long, but it will take a long while to make it short.", author: "Henry David Thoreau" },
  { text: "Think before you speak. Read before you think.", author: "Fran Lebowitz" },
  { text: "My task, which I am trying to achieve is, by the power of the written word, to make you hear, to make you feel — it is, before all, to make you see.", author: "Joseph Conrad" },
  { text: "Use the time of a total stranger in such a way that he or she will not feel the time was wasted.", author: "Kurt Vonnegut" },
  { text: "Every character should want something, even if it's only a glass of water.", author: "Kurt Vonnegut" },
  { text: "Write to please just one person. If you open a window and make love to the world, your story will get pneumonia.", author: "Kurt Vonnegut" },
  { text: "Be a sadist. No matter how sweet and innocent your leading characters, make awful things happen to them.", author: "Kurt Vonnegut" },
  { text: "Start as close to the end as possible.", author: "Kurt Vonnegut" },
  { text: "Every sentence must do one of two things — reveal character or advance the action.", author: "Kurt Vonnegut" },
  { text: "The road to hell is paved with works-in-progress.", author: "Philip Roth" },
  { text: "Never open a book with weather.", author: "Elmore Leonard" },
  { text: "If it sounds like writing, I rewrite it.", author: "Elmore Leonard" },
  { text: "A writer must teach himself that the basest of all things is to be afraid.", author: "William Faulkner" },
  { text: "A writer needs three things: experience, observation, and imagination, any two of which — at times any one of which — can supply the lack of the others.", author: "William Faulkner" },
  { text: "There is no rule on how to write. Sometimes it comes easily and perfectly; sometimes it's like drilling rock and then blasting it out with charges.", author: "Ernest Hemingway" },
  { text: "All you have to do is write one true sentence. Write the truest sentence that you know.", author: "Ernest Hemingway" },
  { text: "It's none of their business that you have to learn to write. Let them think you were born that way.", author: "Ernest Hemingway" },
  { text: "My aim is to put down on paper what I see and what I feel in the best and simplest way.", author: "Ernest Hemingway" },
  { text: "I'm not a very good writer, but I'm an excellent rewriter.", author: "James Michener" },
  { text: "Writing is easy. All you have to do is cross out the wrong words.", author: "Mark Twain" },
  { text: "The first draft is just you telling yourself the story.", author: "Terry Pratchett" },
  { text: "Writing is an act of faith, not a trick of grammar.", author: "E.B. White" },
  { text: "Writing is an exploration. You start from nothing and learn as you go.", author: "E.L. Doctorow" },
  { text: "One must be ruthless with one's own writing or someone else will be.", author: "John Updike" },
  { text: "Any word you have to hunt for in a thesaurus is the wrong word.", author: "Stephen King" },
  { text: "Reading is the creative center of a writer's life.", author: "Stephen King" },
  { text: "Talent is cheaper than table salt. What separates the talented individual from the successful one is a lot of hard work.", author: "Stephen King" },
  { text: "What I like in a good author is not what he says but what he whispers.", author: "Logan Pearsall Smith" },
  { text: "No passion in the world is equal to the passion to alter someone else's draft.", author: "H.G. Wells" },
  { text: "The faster I write the better my output. If I'm going slow, I'm in trouble.", author: "Raymond Chandler" },
  { text: "This is how you do it: you sit down at the keyboard and you put one word after another until it's done. It's that easy, and that hard.", author: "Neil Gaiman" },
  { text: "Be your own editor/critic. Sympathetic but merciless.", author: "Joyce Carol Oates" },
  { text: "The writer is the one who stays in the room.", author: "Anna Quindlen" },
  { text: "If you stuff yourself full of poems, essays, plays, stories, novels, films, comic strips, magazines, music, you automatically explode every morning like Old Faithful.", author: "Ray Bradbury" },
  { text: "Plot is no more than footprints left in the snow after your characters have run by on their way to incredible destinations.", author: "Ray Bradbury" },
  { text: "Literature adds to reality, it does not simply describe it.", author: "C.S. Lewis" },
  { text: "There is something delicious about writing the first words of a story. You never quite know where they'll take you.", author: "Beatrix Potter" },
  { text: "Writing is the only way I have to explain my own life to myself.", author: "Pat Conroy" },
  { text: "I don't wait for moods. You accomplish nothing if you do that. Your mind must know it has got to get down to work.", author: "Pearl S. Buck" },
  { text: "The pages are still blank, but there is a miraculous feeling of the words being there, written in invisible ink and clamoring to become visible.", author: "Vladimir Nabokov" },
  { text: "Writing is not apart from living. Writing is a kind of double living.", author: "Catherine Drinker Bowen" },
  { text: "A writer's job is to imagine everything so personally that the fiction is as vivid as memories.", author: "John Irving" },
  { text: "Don't get it right, just get it written.", author: "James Thurber" },
  { text: "Write what should not be forgotten.", author: "Isabel Allende" },
  { text: "The good writer seems to be writing about himself, but has his eye always on that thread of the Universe which runs through himself and all things.", author: "Ralph Waldo Emerson" },
  { text: "Great literature is simply language charged with meaning to the utmost possible degree.", author: "Ezra Pound" },
  { text: "I kept always two books in my pocket, one to read, one to write in.", author: "Robert Louis Stevenson" },
  { text: "One of the most difficult things is the first paragraph. I have spent many months on a first paragraph, and once I get it, the rest just comes out very easily.", author: "Gabriel García Márquez" },
  { text: "Work on one thing at a time until finished.", author: "Henry Miller" },
  { text: "A word is not the same with one writer as with another. One tears it from his guts. The other pulls it out of his overcoat pocket.", author: "Charles Péguy" },
  { text: "Write the book you want to read.", author: "Austin Kleon" },
  { text: "Voice is the most mysterious element of writing.", author: "Dani Shapiro" },
  { text: "The most important thing is to read as much as you can, like I did. It will give you an understanding of what makes good writing and it will enlarge your vocabulary.", author: "J.K. Rowling" },
  { text: "I would hurl words into this darkness and wait for an echo, and if an echo sounded, no matter how faintly, I would send other words to tell, to march, to fight.", author: "Richard Wright" },
  { text: "Style is knowing who you are, what you want to say, and not giving a damn.", author: "Gore Vidal" },
  { text: "Writing is a form of therapy; sometimes I wonder how all those who do not write, compose or paint can manage to escape the madness, melancholia, the panic fear which is inherent in the human situation.", author: "Graham Greene" },
  { text: "I write when I'm inspired, and I see to it that I'm inspired at nine o'clock every morning.", author: "Peter De Vries" },
  { text: "A story should have a beginning, a middle, and an end, but not necessarily in that order.", author: "Jean-Luc Godard" },
  { text: "Better to write for yourself and have no public, than to write for the public and have no self.", author: "Cyril Connolly" },
  { text: "Do not hoard what seems good for a later place in the book, or for another book; give it, give it all, give it now.", author: "Annie Dillard" },
  { text: "Write as if you were dying.", author: "Annie Dillard" },
  { text: "We do not write because we want to; we write because we have to.", author: "W. Somerset Maugham" },
  { text: "The worst enemy to creativity is self-doubt.", author: "Sylvia Plath" },
  { text: "Let me live, love, and say it well in good sentences.", author: "Sylvia Plath" },
  { text: "The most essential gift for a good writer is a built-in, shock-proof shit detector. This is the writer's radar and all great writers have had it.", author: "Ernest Hemingway" },
  { text: "In a story, the problem is almost always character.", author: "George Saunders" },
  { text: "Write towards vulnerability. Don't write away from it.", author: "Cheryl Strayed" },
  { text: "When in doubt, make trouble for your character.", author: "Janet Burroway" },
  { text: "You can fix anything but a blank page.", author: "Nora Roberts" },
  { text: "The act of writing is an act of optimism. You would not take the trouble to do it if you felt it didn't matter.", author: "Edward Albee" },
  { text: "Writing a novel is like heading out over a huge lake on a frozen night, hoping the ice will hold until you get to the other side.", author: "Anne Tyler" },
  { text: "A poet can survive everything but a misprint.", author: "Oscar Wilde" },
  { text: "The desire to write grows with writing.", author: "Erasmus" },
  { text: "Start telling the stories that only you can tell, because there'll always be better writers than you and there'll always be smarter writers than you.", author: "Neil Gaiman" },
  { text: "When writing a novel, a writer should create living people; people not characters. A character is a caricature.", author: "Ernest Hemingway" },
  { text: "If there is a special hell for writers it would be in the forced contemplation of their own works.", author: "John Dos Passos" },
  { text: "The novel is a mirror walking down a road.", author: "Stendhal" },
  { text: "You can't think yourself out of a writing block; you have to write yourself out of a thinking block.", author: "John Rogers" },
  { text: "If you have the words, there's always a chance that you'll find the way.", author: "Seamus Heaney" },
  { text: "To defend what you've written is a sign that you are alive.", author: "William Zinsser" },
  { text: "A sentence should contain no unnecessary words, a paragraph no unnecessary sentences, for the same reason that a drawing should have no unnecessary lines.", author: "William Strunk Jr." },
  { text: "Writing is easy; all you do is sit staring at a blank sheet of paper until drops of blood form on your forehead.", author: "Gene Fowler" },
  { text: "I never know what I think about something until I read what I've written on it.", author: "William Faulkner" },
  { text: "It's possible, in a poem or short story, to write about commonplace things and objects using commonplace but precise language, and to endow those things with immense, even startling power.", author: "Raymond Carver" },
];
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatListModule } from '@angular/material/list';
import { MatSelectModule } from '@angular/material/select';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { TextFieldModule } from '@angular/cdk/text-field';
import { SeriesService } from './series.service';
import { AuthService } from '../auth/auth.service';
import { Series } from '@shared/models/series.model';
import { RecentChaptersService } from '../services/recent-chapters.service';
import { v4 as uuidv4 } from 'uuid';
import { SlideOutPanelContainer } from '../shared/slide-out-panel-container/slide-out-panel-container';
import { WritingStatsSummaryComponent } from '../writing-stats/writing-stats-summary';

@Component({
  selector: 'app-series',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatListModule,
    MatSelectModule,
    MatDividerModule,
    MatChipsModule,
    TextFieldModule,
    SlideOutPanelContainer,
    WritingStatsSummaryComponent,
  ],
  templateUrl: './series.html',
  styleUrl: './series.scss',
})
export class SeriesComponent implements OnInit {
  private seriesService = inject(SeriesService);
  private authService = inject(AuthService);
  private router = inject(Router);
  private recentChaptersService = inject(RecentChaptersService);

  readonly recentChapters = this.recentChaptersService.recentChapters;

  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    if (hour < 21) return 'Good evening';
    return 'Good night';
  });

  readonly firstName = computed(() =>
    (this.authService.currentUser()?.name ?? '').split(' ')[0]
  );

  readonly quoteIndex = signal(Math.floor(Math.random() * WRITING_QUOTES.length));
  readonly quote = computed(() => WRITING_QUOTES[this.quoteIndex()]);
  readonly quoteCount = WRITING_QUOTES.length;
  readonly quoteVisible = signal(true);

  seriesList = signal<Series[]>([]);
  loading = signal(false);
  showPanel = signal(false);
  editingSeries = signal<Series | null>(null);
  isNew = signal(false);
  uploading = signal(false);
  thumbnailPreview = signal<string | null>(null);

  generatingPrompt = signal(false);

  newCollaboratorEmail = signal('');
  collaboratorError = signal<string | null>(null);

  ownedSeries = computed(() => {
    const email = this.authService.currentUser()?.email;
    return this.seriesList().filter(s => s.owner === email);
  });

  sharedSeries = computed(() => {
    const email = this.authService.currentUser()?.email;
    return this.seriesList().filter(s => s.owner !== email);
  });

  private cycle(direction: 1 | -1): void {
    this.quoteVisible.set(false);
    setTimeout(() => {
      this.quoteIndex.update(i => (i + direction + WRITING_QUOTES.length) % WRITING_QUOTES.length);
      this.quoteVisible.set(true);
    }, 180);
  }

  prevQuote(): void { this.cycle(-1); }
  nextQuote(): void { this.cycle(1); }

  ngOnInit(): void {
    this.loadSeries();
  }

  loadSeries(): void {
    this.loading.set(true);
    this.seriesService.getAll().subscribe({
      next: (data) => {
        this.seriesList.set(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  openNew(): void {
    this.editingSeries.set({ id: '', title: '', thumnailUrl: '' });
    this.isNew.set(true);
    this.thumbnailPreview.set(null);
    this.showPanel.set(true);
  }

  openEdit(series: Series): void {
    this.editingSeries.set({ ...series });
    this.isNew.set(false);
    this.thumbnailPreview.set(this.proxyUrl(series.thumnailUrl));
    this.showPanel.set(true);
  }

  onPanelChanged(open: boolean): void {
    this.showPanel.set(open);
    if (!open) {
      this.editingSeries.set(null);
      this.thumbnailPreview.set(null);
      this.newCollaboratorEmail.set('');
      this.collaboratorError.set(null);
    }
  }

  closePanel(): void {
    this.showPanel.set(false);
    this.editingSeries.set(null);
    this.thumbnailPreview.set(null);
    this.newCollaboratorEmail.set('');
    this.collaboratorError.set(null);
  }

  updateTitle(value: string): void {
    const current = this.editingSeries();
    if (current) {
      this.editingSeries.set({ ...current, title: value });
    }
  }

  updateSystemPrompt(value: string): void {
    const current = this.editingSeries();
    if (current) {
      this.editingSeries.set({ ...current, systemPrompt: value });
    }
  }

  generateSystemPrompt(): void {
    const s = this.editingSeries();
    if (!s) return;
    this.generatingPrompt.set(true);
    this.seriesService.generateSystemPrompt(s.id, s.systemPrompt ?? '').subscribe({
      next: ({ systemPrompt }) => {
        this.editingSeries.set({ ...s, systemPrompt });
        this.generatingPrompt.set(false);
      },
      error: () => this.generatingPrompt.set(false),
    });
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Show local preview immediately
    const reader = new FileReader();
    reader.onload = () => this.thumbnailPreview.set(reader.result as string);
    reader.readAsDataURL(file);

    // Upload to Azure
    this.uploading.set(true);
    this.seriesService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        const current = this.editingSeries();
        if (current) {
          this.editingSeries.set({ ...current, thumnailUrl: thumbnailUrl, originalUrl: url });
        }
        // Switch preview from local data URL to the proxy URL
        this.thumbnailPreview.set(this.proxyUrl(thumbnailUrl));
        this.uploading.set(false);
      },
      error: () => this.uploading.set(false),
    });
  }

  saveEdit(): void {
    const editing = this.editingSeries();
    if (!editing || !editing.title.trim()) return;

    if (this.isNew()) {
      const series: Series = { ...editing, id: uuidv4() };
      this.seriesService.create(series).subscribe({
        next: (created) => {
          this.seriesList.update((list) => [...list, created]);
          this.closePanel();
        },
      });
    } else {
      this.seriesService.update(editing).subscribe({
        next: (updated) => {
          this.seriesList.update((list) =>
            list.map((s) => (s.id === updated.id ? updated : s))
          );
          this.closePanel();
        },
      });
    }
  }

  proxyUrl(azureUrl: string | undefined): string | null {
    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  addCollaborator(): void {
    const s = this.editingSeries();
    const email = this.newCollaboratorEmail().trim();
    if (!s || !email) return;
    this.collaboratorError.set(null);
    this.seriesService.addCollaborator(s.id, email).subscribe({
      next: (updated) => {
        this.editingSeries.set(updated);
        this.seriesList.update(list => list.map(x => x.id === updated.id ? updated : x));
        this.newCollaboratorEmail.set('');
      },
      error: (err) => {
        this.collaboratorError.set(err?.error?.error ?? 'Failed to add collaborator');
      },
    });
  }

  removeCollaborator(email: string): void {
    const s = this.editingSeries();
    if (!s) return;
    this.seriesService.removeCollaborator(s.id, email).subscribe({
      next: (updated) => {
        this.editingSeries.set(updated);
        this.seriesList.update(list => list.map(x => x.id === updated.id ? updated : x));
      },
    });
 }

  navigateToDetail(seriesId: string): void {
    this.router.navigate(['/series', seriesId]);
  }

  navigateToChapter(chapterId: string): void {
    this.router.navigate(['/chapters', chapterId, 'edit']);
  }

  removeRecentChapter(chapterId: string): void {
    this.recentChaptersService.remove(chapterId);
  }

}

