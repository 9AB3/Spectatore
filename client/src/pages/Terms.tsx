import Header from '../components/Header';
import TermsContent from '../components/TermsContent';

export default function Terms() {
  return (
    <div>
      <Header />
      <div className="max-w-3xl mx-auto p-4 pb-24">
        <div className="card p-5">
          <TermsContent />
        </div>
      </div>
    </div>
  );
}
